/**
 * Composio routing: domain → connected toolkit(s) → exact action(s).
 *
 * Stage 1 (one Jev request, parallel questions): which sold domain, which of
 * the user's connected toolkits, and whether any connected-app action is
 * needed at all. Stage 2: rank every action of the chosen toolkit(s) (a
 * sharded tournament when a toolkit has hundreds of actions), then verify the
 * top candidates independently so multi-step tasks get every action they need.
 *
 * The router only proposes. Execution still goes through the normal tool
 * dispatch, which applies allowlists, account scope, idempotency, and the
 * approval policy in src/policy.ts. Routed actions are exposed with their real
 * Composio schema so the model can skip broad search and schema lookups.
 */
import { config } from "../config.js";
import { composioDomainCatalog, resolveComposioRoute, toolkitKey, type ComposioDomain, type ComposioRoute } from "../composioRouting.js";
import { logger } from "../logger.js";
import { NONE_OPTION, awaitRoute, jevClient, jevEnabled, jevText, rankOptions, verifyCandidates, type JevChoiceAnswer, type JevClient, type JevNoulAnswer, type JevQuestion, type RankedOption, type RoutingDeadline } from "./jev.js";
import { recordDecision } from "./telemetry.js";

export type ComposioAction = {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  /** JSON schema for the action input, when Composio returned one. */
  inputParameters?: Record<string, unknown>;
  deprecated?: boolean;
};

export type ComposioActionLister = (toolkit: string, signal?: AbortSignal) => Promise<ComposioAction[]>;

/** One entry of Composio's public toolkit catalogue (not user data). */
export type ComposioToolkitInfo = { slug: string; name: string; description: string; categories: string[] };
export type ComposioToolkitLister = (signal?: AbortSignal) => Promise<ComposioToolkitInfo[]>;

export type ComposioDecision = {
  source: "jev" | "keyword";
  route?: ComposioRoute;
  toolkits: Array<RankedOption & { connected?: boolean }>;
  /** Routed toolkits the user has not connected yet (connect before executing). */
  unconnectedToolkits: string[];
  actions: Array<RankedOption & { verified?: number; toolkit: string; description: string; connected?: boolean }>;
  /** OpenAI function definitions for routed actions with a full schema. */
  directTools: unknown[];
  needsAppAction?: number;
  fallbackReason?: string;
  telemetry?: { latencyMs: number; costUsd: number; calls: number };
};

const ACTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ACTION_CACHE_MAX = 64;
const actionCache = new Map<string, { at: number; actions: ComposioAction[] }>();
const inflight = new Map<string, Promise<ComposioAction[]>>();

let toolkitCatalogue: { at: number; toolkits: ComposioToolkitInfo[] } | undefined;
let toolkitInflight: Promise<ComposioToolkitInfo[]> | undefined;

export function clearComposioActionCache(): void { actionCache.clear(); inflight.clear(); toolkitCatalogue = undefined; toolkitInflight = undefined; }

/** Cached Composio toolkit catalogue (public metadata), shared across users. */
export async function cachedToolkitCatalogue(lister: ComposioToolkitLister, signal?: AbortSignal): Promise<ComposioToolkitInfo[]> {
  if (toolkitCatalogue && Date.now() - toolkitCatalogue.at < ACTION_CACHE_TTL_MS) return toolkitCatalogue.toolkits;
  toolkitInflight ??= lister(signal).then((toolkits) => {
    const unique = new Map<string, ComposioToolkitInfo>();
    for (const toolkit of toolkits) if (toolkit.slug && !unique.has(toolkitKey(toolkit.slug))) unique.set(toolkitKey(toolkit.slug), toolkit);
    const clean = [...unique.values()].slice(0, config.jevComposioCatalogLimit);
    toolkitCatalogue = { at: Date.now(), toolkits: clean };
    return clean;
  }).finally(() => { toolkitInflight = undefined; });
  return toolkitInflight;
}

/** Map a raw Composio toolkit record (toolkits.get) to routing metadata. */
export function toComposioToolkitInfo(raw: unknown): ComposioToolkitInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const slug = String(row.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(slug)) return undefined;
  const meta = row.meta && typeof row.meta === "object" ? row.meta as Record<string, unknown> : {};
  const categories = Array.isArray(meta.categories)
    ? meta.categories.map((item) => jevText((item as Record<string, unknown>)?.name ?? (item as Record<string, unknown>)?.slug ?? "", 60)).filter(Boolean).slice(0, 4)
    : [];
  return { slug, name: jevText(row.name ?? slug, 80), description: jevText(meta.description ?? row.description ?? "", 400), categories };
}

/** Cached, de-duplicated action catalogue lookup for one toolkit. */
export async function cachedToolkitActions(toolkit: string, lister: ComposioActionLister, signal?: AbortSignal): Promise<ComposioAction[]> {
  const key = toolkitKey(toolkit);
  const hit = actionCache.get(key);
  if (hit && Date.now() - hit.at < ACTION_CACHE_TTL_MS) return hit.actions;
  const pending = inflight.get(key) ?? lister(toolkit, signal).then((actions) => {
    const clean = actions.filter((action) => action.slug && !action.deprecated);
    if (actionCache.size >= ACTION_CACHE_MAX) actionCache.delete(actionCache.keys().next().value as string);
    actionCache.set(key, { at: Date.now(), actions: clean });
    return clean;
  }).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/** Map a raw Composio tool record (getRawComposioTools) to a routing action. */
export function toComposioAction(raw: unknown, fallbackToolkit: string): ComposioAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const slug = String(row.slug ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,160}$/.test(slug)) return undefined;
  const toolkitRow = row.toolkit && typeof row.toolkit === "object" ? row.toolkit as Record<string, unknown> : {};
  const input = row.inputParameters ?? row.input_parameters;
  return {
    slug,
    name: jevText(row.name ?? slug, 160),
    description: jevText(row.description ?? row.name ?? slug, 1_000),
    toolkit: String(toolkitRow.slug ?? fallbackToolkit).toLowerCase(),
    ...(input && typeof input === "object" && !Array.isArray(input) ? { inputParameters: input as Record<string, unknown> } : {}),
    ...(row.isDeprecated === true ? { deprecated: true } : {}),
  };
}

function domainCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const route of composioDomainCatalog()) criteria[route.domain] = `${route.domain}: ${route.terms.join(", ")} (apps such as ${route.toolkits.join(", ")})`;
  criteria[NONE_OPTION] = "None of these business domains, or no connected app is involved.";
  return criteria;
}

function toolkitDescription(slug: string, connected: boolean, info?: ComposioToolkitInfo): string {
  const key = toolkitKey(slug);
  const family = composioDomainCatalog().find((route) => route.toolkits.some((toolkit) => toolkitKey(toolkit) === key));
  const status = connected ? "CONNECTED" : "not connected (user can connect it)";
  const about = info?.description || (family ? `${family.domain}: ${family.terms.slice(0, 5).join(", ")}` : "");
  const categories = info?.categories.length ? ` [${info.categories.join(", ")}]` : "";
  return jevText(`${info?.name ?? slug} — ${status}${categories}${about ? `: ${about}` : ""}`, 260);
}

function directTool(action: ComposioAction): unknown | undefined {
  const parameters = action.inputParameters;
  if (!parameters || parameters.type !== "object") return undefined;
  return { type: "function", function: { name: action.slug, description: action.description.slice(0, 1_000), parameters } };
}

function activeToolkits(accounts: Array<{ toolkit: string; status?: string }>): string[] {
  const seen = new Map<string, string>();
  for (const account of accounts) {
    if (account.status && account.status.toUpperCase() !== "ACTIVE") continue;
    const key = toolkitKey(account.toolkit);
    if (key && !seen.has(key)) seen.set(key, account.toolkit.toLowerCase());
  }
  return [...seen.values()].slice(0, 120);
}

export function keywordComposioDecision(objective: string, accounts: Array<{ toolkit: string; status?: string }>, reason?: string): ComposioDecision {
  const route = resolveComposioRoute(objective, accounts.map((account) => account.toolkit));
  return {
    source: "keyword",
    ...(route ? { route } : {}),
    toolkits: (route?.connectedToolkits ?? []).map((id) => ({ id, probability: 1, connected: true })),
    unconnectedToolkits: route?.needsConnection ? [...route.preferredToolkits] : [],
    actions: [],
    directTools: [],
    ...(reason ? { fallbackReason: reason } : {}),
  };
}

export async function computeJevComposioDecision(objective: string, input: {
  accounts: Array<{ toolkit: string; status?: string }>;
  listActions: ComposioActionLister;
  listToolkits?: ComposioToolkitLister;
  client?: JevClient;
  signal?: AbortSignal;
  recentContext?: string;
  sessionId?: string;
}): Promise<ComposioDecision> {
  const client = input.client ?? jevClient();
  const connected = activeToolkits(input.accounts);
  const state = {
    request: jevText(objective, 3_000),
    connected_toolkits: connected,
    ...(input.recentContext ? { recent_conversation: jevText(input.recentContext, 1_200) } : {}),
  };
  const questions: Record<string, JevQuestion> = {
    domain: { type: "choice", instructions: "Which business domain does `request` belong to?", criteria: domainCriteria() },
    needs_app: {
      type: "noul",
      instructions: "Does completing `request` require reading from or acting in a third-party app (email, CRM, calendar, billing, store, support desk, documents, and similar), whether or not it is connected yet?",
      criteria: { true: "A third-party app read or action is required.", false: "It can be answered or produced without touching any app." },
    },
  };
  // Candidate toolkits: everything the user connected plus Composio's public
  // catalogue, so a request can route to an app that is not connected yet and
  // the agent can offer the connection instead of substituting another app.
  const connectedSet = new Set(connected.map(toolkitKey));
  let catalogue: ComposioToolkitInfo[] = [];
  if (config.jevComposioRouteUnconnected && input.listToolkits) {
    try { catalogue = await cachedToolkitCatalogue(input.listToolkits, input.signal); }
    catch (error) { logger.debug({ err: error }, "Composio toolkit catalogue unavailable; routing connected toolkits only"); }
  }
  const infoByKey = new Map(catalogue.map((toolkit) => [toolkitKey(toolkit.slug), toolkit]));
  const candidateSlugs = [...new Map([...connected, ...catalogue.map((toolkit) => toolkit.slug)].map((slug) => [toolkitKey(slug), slug.toLowerCase()])).values()];
  const [triage, toolkitRanking] = await Promise.all([
    client.evaluate(state, questions, { signal: input.signal, sessionId: input.sessionId }),
    candidateSlugs.length
      ? rankOptions(client, {
        state,
        instructions: "Which app should Chusky use to complete `request`? Prefer a CONNECTED app that can do the job. Choose a not-connected app when the user names it or when no connected app can do the job.",
        options: candidateSlugs.map((slug) => ({ id: slug, description: toolkitDescription(slug, connectedSet.has(toolkitKey(slug)), infoByKey.get(toolkitKey(slug))) })),
        noneDescription: "No app is needed for this request.",
        signal: input.signal,
        sessionId: input.sessionId,
      })
      : Promise.resolve(undefined),
  ]);
  let latencyMs = Math.max(triage.latencyMs, toolkitRanking?.latencyMs ?? 0);
  let costUsd = (triage.costUsd ?? 0) + (toolkitRanking?.costUsd ?? 0);
  let calls = 1 + (toolkitRanking?.calls ?? 0);
  const domainAnswer = triage.answers.domain as JevChoiceAnswer;
  const needsAppAnswer = (triage.answers.needs_app as JevNoulAnswer).noul;
  const toolkits = (toolkitRanking?.ranked ?? []).map((item) => ({ ...item, connected: connectedSet.has(toolkitKey(item.id)) }));
  const domain = domainAnswer.choice !== NONE_OPTION && domainAnswer.confidence >= config.jevMinConfidence ? domainAnswer.choice as ComposioDomain : undefined;
  const selectedRanked = toolkits.filter((item, index) => item.probability >= config.jevToolkitMinProbability && index < 2);
  // The two signals are complementary: a request that names an app ("post in
  // Slack") may score low on the generic needs-app question while the toolkit
  // ranking is confident. Take the stronger signal so neither can suppress
  // the other.
  const needsApp = Math.max(needsAppAnswer, selectedRanked.length ? 1 - (toolkitRanking?.none ?? 1) : 0);
  const selected = selectedRanked.map((item) => item.id);
  const selectedConnected = selectedRanked.filter((item) => item.connected).map((item) => item.id);
  const unconnected = needsApp >= 0.35 ? selectedRanked.filter((item) => !item.connected).map((item) => item.id) : [];

  let route: ComposioRoute | undefined;
  if (domain || selected.length) {
    const family = domain ? composioDomainCatalog().find((item) => item.domain === domain) : undefined;
    const familyConnected = (family?.toolkits ?? []).filter((toolkit) => connectedSet.has(toolkitKey(toolkit)));
    const active = selected.length ? selectedConnected : familyConnected;
    const preferred = [...new Set([...selected, ...(family?.toolkits ?? [])])];
    const inferredDomain = domain ?? composioDomainCatalog().find((item) => item.toolkits.some((toolkit) => selected.some((slug) => toolkitKey(slug) === toolkitKey(toolkit))))?.domain;
    if (inferredDomain) {
      route = {
        domain: inferredDomain,
        preferredToolkits: preferred,
        connectedToolkits: active,
        // The top routed app is not connected (or nothing in the family is).
        needsConnection: needsApp >= 0.5 && (selectedRanked[0] ? !selectedRanked[0].connected : !active.length),
      };
    }
  }
  const decision: ComposioDecision = { source: "jev", ...(route ? { route } : {}), toolkits: toolkits.slice(0, 5), unconnectedToolkits: unconnected, actions: [], directTools: [], needsAppAction: needsApp };
  if (needsApp < 0.35 || !selected.length) {
    decision.telemetry = { latencyMs, costUsd, calls };
    if (!domain && domainAnswer.confidence < config.jevMinConfidence && needsApp >= 0.35) decision.fallbackReason = "low_confidence";
    return decision;
  }

  const catalogues = await Promise.all(selected.map(async (toolkit) => {
    try { return await cachedToolkitActions(toolkit, input.listActions, input.signal); }
    catch (error) { logger.debug({ err: error, toolkit }, "Composio action catalogue unavailable for routing"); return []; }
  }));
  const actions = catalogues.flat();
  if (!actions.length) { decision.telemetry = { latencyMs, costUsd, calls }; return decision; }
  const bySlug = new Map(actions.map((action) => [action.slug, action]));
  const ranking = await rankOptions(client, {
    state,
    instructions: "Which app action should Chusky execute first to make real progress on `request`? Prefer the most specific action that directly performs or reads what is asked.",
    options: actions.map((action) => ({ id: action.slug, description: `${action.name}: ${action.description}` })),
    noneDescription: "None of these actions fits the request.",
    signal: input.signal,
    sessionId: input.sessionId,
  });
  latencyMs += ranking.latencyMs; costUsd += ranking.costUsd; calls += ranking.calls;
  const candidates = ranking.ranked.filter((item) => item.probability >= 0.01).slice(0, 6);
  const verification = candidates.length
    ? await verifyCandidates(client, {
      state,
      candidates: candidates.map((item) => ({ id: item.id, description: `${bySlug.get(item.id)?.name ?? item.id}: ${bySlug.get(item.id)?.description ?? ""}` })),
      question: () => "Will Chusky need to call `candidate` at some step to complete `request`?",
      criteria: { true: "This action is a required read or step for the request.", false: "This action is unrelated or unnecessary for the request." },
      signal: input.signal,
      sessionId: input.sessionId,
    })
    : { scores: {} as Record<string, number>, latencyMs: 0, costUsd: 0 };
  latencyMs += verification.latencyMs; costUsd += verification.costUsd; calls += candidates.length ? 1 : 0;

  decision.actions = candidates
    .filter((item, index) => index === 0 ? (verification.scores[item.id] ?? 0) >= config.jevActionVerifyThreshold || item.probability >= config.jevInjectActionMinProbability : (verification.scores[item.id] ?? 0) >= config.jevActionVerifyThreshold)
    .slice(0, 4)
    .map((item) => {
      const toolkit = bySlug.get(item.id)?.toolkit ?? "";
      return { ...item, verified: verification.scores[item.id], toolkit, description: bySlug.get(item.id)?.description ?? "", connected: connectedSet.has(toolkitKey(toolkit)) };
    });
  // Only connected toolkits can execute, so only they become direct tools.
  decision.directTools = decision.actions
    .filter((item) => item.connected)
    .filter((item) => item.probability >= config.jevInjectActionMinProbability || (item.verified ?? 0) >= 0.75)
    .slice(0, 3)
    .map((item) => bySlug.get(item.id))
    .map((action) => action ? directTool(action) : undefined)
    .filter(Boolean) as unknown[];
  if (!decision.actions.length && ranking.confidence < config.jevMinConfidence) decision.fallbackReason = "low_confidence_actions";
  decision.telemetry = { latencyMs, costUsd, calls };
  return decision;
}

/** Model-facing routing context. Contains no private account aliases. */
export function composioDecisionContext(decision: ComposioDecision): string {
  const lines: string[] = [];
  const route = decision.route;
  const connectHint = (toolkits: string[]) => `${toolkits.join(" or ")} ${toolkits.length > 1 ? "are" : "is"} not connected yet. Call COMPOSIO_MANAGE_CONNECTIONS for ${toolkits[0]} to give the user a connection link, tell them what it unlocks, and continue once it is connected. Do not substitute an unrelated app.`;
  if (route) {
    lines.push(route.needsConnection
      ? `Composio route: ${route.domain}; best app(s): ${route.preferredToolkits.slice(0, 4).join(", ")}.${route.connectedToolkits.length ? ` Connected alternative(s): ${route.connectedToolkits.join(", ")}.` : ""}`
      : `Composio route: ${route.domain}; use connected toolkit(s): ${route.connectedToolkits.join(", ") || "none selected"}. Inspect the exact action schema before executing; broad search is last resort.`);
  } else if (decision.source === "jev" && decision.toolkits.length && (decision.needsAppAction ?? 0) >= 0.35) {
    const picks = decision.toolkits.filter((item) => item.probability >= config.jevToolkitMinProbability).slice(0, 2);
    const connected = picks.filter((item) => item.connected).map((item) => item.id);
    if (connected.length) lines.push(`Composio route: use connected toolkit(s) ${connected.join(", ")}. Inspect the exact action schema before executing; broad search is last resort.`);
  }
  const unconnected = decision.unconnectedToolkits.length ? decision.unconnectedToolkits : route?.needsConnection ? route.preferredToolkits.filter((toolkit) => !route.connectedToolkits.includes(toolkit)).slice(0, 2) : [];
  if (unconnected.length) lines.push(connectHint(unconnected));
  if (decision.actions.length) {
    const direct = new Set(decision.directTools.map((tool) => String((tool as { function?: { name?: string } })?.function?.name ?? "")));
    lines.push("Routed app actions (ranked by the decision model; verify arguments, never skip approvals):");
    for (const action of decision.actions) {
      const state = direct.has(action.id) ? " (loaded as a direct tool)" : action.connected === false ? " (app not connected; connect first)" : "";
      lines.push(`- ${action.id} [${action.toolkit}] p=${action.probability.toFixed(2)}${state}: ${action.description.slice(0, 220)}`);
    }
    lines.push("Call a loaded direct tool with schema-valid arguments. For other listed actions on connected apps, fetch the schema with COMPOSIO_GET_TOOL_SCHEMAS and run them with COMPOSIO_MULTI_EXECUTE_TOOL. Use COMPOSIO_SEARCH_TOOLS only if none of these fit.");
  }
  return lines.join("\n");
}

/**
 * Route one supervisor turn according to JEV_MODE (off/shadow/enforce).
 * Always resolves; never throws.
 */
export async function routeComposioForTurn(objective: string, input: {
  accounts: Array<{ toolkit: string; status?: string }>;
  listActions: ComposioActionLister;
  listToolkits?: ComposioToolkitLister;
  client?: JevClient;
  signal?: AbortSignal;
  recentContext?: string;
  sessionId?: string;
  budgetMs?: number;
  deadline?: RoutingDeadline;
}): Promise<ComposioDecision> {
  const baseline = keywordComposioDecision(objective, input.accounts);
  if (!objective.trim() || !jevEnabled("composio")) return baseline;
  const client = input.client ?? jevClient();
  if (!client.available()) return { ...baseline, fallbackReason: "jev_unavailable" };
  const enforce = config.jevMode === "enforce";
  const run = computeJevComposioDecision(objective, { ...input, client, signal: enforce && input.deadline ? input.deadline.signal : input.signal });
  const log = (decision: ComposioDecision | undefined, applied: boolean, reason?: string) => {
    const mode = config.jevMode === "enforce" ? "enforce" : "shadow";
    recordDecision({
      surface: "composio_toolkit", mode, applied, ...(reason ? { fallbackReason: reason } : {}),
      ...(decision ? { jev: decision.toolkits.map((item) => ({ id: item.id, p: item.probability })) } : {}),
      baseline: baseline.route?.connectedToolkits ?? [],
      ...(decision?.telemetry ? { latencyMs: decision.telemetry.latencyMs, costUsd: decision.telemetry.costUsd } : {}),
      model: client.modelId,
    });
    if (decision?.actions.length) recordDecision({ surface: "composio_action", mode, applied, jev: decision.actions.map((item) => ({ id: item.id, p: item.probability })), model: client.modelId });
  };
  if (config.jevMode === "shadow") {
    run.then((decision) => log(decision, false, decision.fallbackReason)).catch((error) => log(undefined, false, (error as { reason?: string })?.reason ?? "error"));
    return baseline;
  }
  const { value: decision, failure } = await awaitRoute(run, input.deadline ? input.deadline.remaining() : input.budgetMs ?? config.jevTurnBudgetMs);
  if (!decision || (decision.fallbackReason && !decision.actions.length && !decision.route)) {
    const reason = failure ?? decision?.fallbackReason ?? "unavailable";
    log(decision, false, reason);
    return { ...baseline, fallbackReason: reason };
  }
  // Jev is additive: a keyword domain route (including the deterministic
  // "not connected" guard) is kept when Jev produced no route of its own.
  if (!decision.route && baseline.route) decision.route = baseline.route;
  log(decision, true);
  return decision;
}
