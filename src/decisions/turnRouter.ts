/**
 * One-turn Jev routing plan.
 *
 * Jev is strongest when independent judgments share one state and one
 * request. This module builds that request once for the supervisor turn. It
 * returns routing proposals only; account scope, approvals, tool schemas,
 * and execution remain in the existing deterministic boundaries.
 */
import { config } from "../config.js";
import { composioDomainCatalog, resolveComposioRoute, toolkitKey, type ComposioDomain } from "../composioRouting.js";
import { listSkillSummaries } from "../skills/catalog.js";
import { explicitlyNamedSkills, type SkillRoute } from "./skillRouter.js";
import { nativeToolCapabilityCard, nativeToolRouteFromJevScores, type NativeToolDescriptor, type NativeToolRoute } from "./nativeToolRouter.js";
import { TREG_TOOL_CRITERIA, type TregTurnRoute } from "./tregRouter.js";
import { NONE_OPTION, type JevChoiceAnswer, type JevClient, type JevNoulAnswer, type JevQuestion, type JevResult, jevClient, jevEnabled, jevText } from "./jev.js";
import { recordDecision } from "./telemetry.js";
import type { TurnActionDecision } from "./actionGate.js";
import type { ComposioDecision } from "./composioRouter.js";

type Candidate = { id: string; description: string; aliases?: string[]; capabilities?: string[] };

export type TurnRoutingPlanInput = {
  query: string;
  recentContext?: string;
  skills?: Array<{ name: string; description: string }>;
  nativeCandidates?: NativeToolDescriptor[];
  connectedAccounts?: Array<{ toolkit: string; status?: string }>;
  forceCapability?: boolean;
  includeSkills?: boolean;
  includeNative?: boolean;
  includeComposio?: boolean;
  includeTreg?: boolean;
  includeMonid?: boolean;
  preserveNativeTools?: boolean;
  availableNativeTools?: any[];
  signal?: AbortSignal;
  sessionId?: string;
  client?: JevClient;
};

export type TurnRoutingPlan = {
  action: TurnActionDecision;
  skillRoute?: SkillRoute;
  nativeToolRoute?: NativeToolRoute;
  composioDecision?: ComposioDecision;
  tregRoute?: TregTurnRoute;
  monidRoute?: MonidTurnRoute;
  externalDataBackend?: ExternalDataBackendRoute;
  /** Stage-1 result reused by Composio's dependent exact-action phase. */
  composioStage1?: ComposioDecision;
  result: JevResult;
};

export type MonidTurnRoute = {
  needed: number;
  selected: string[];
  source: "jev";
  fallbackReason?: string;
  telemetry: { latencyMs: number; costUsd: number };
};

export type ExternalDataBackend = "treg" | "monid" | "none";
export type ExternalDataBackendRoute = {
  selected?: ExternalDataBackend;
  probability: number;
  confidence: number;
  source: "jev";
  fallbackReason?: string;
};

const NO_ACTION_MAX_PROBABILITY = 0.08;
const APP_NEEDED_THRESHOLD = 0.35;

function activeToolkits(accounts: Array<{ toolkit: string; status?: string }>): string[] {
  const seen = new Map<string, string>();
  for (const account of accounts) {
    if (account.status && account.status.toUpperCase() !== "ACTIVE") continue;
    const key = toolkitKey(account.toolkit);
    if (key && !seen.has(key)) seen.set(key, account.toolkit.toLowerCase());
  }
  return [...seen.values()].slice(0, 120);
}

/**
 * High-signal vocabulary for the deterministic candidate pre-filter.
 *
 * Keep these mappings pointed at canonical concepts instead of making every
 * word expand into a full synonym cluster. `words()` runs for both the user
 * request and the candidate metadata, which makes the matching effectively
 * symmetric without inflating scores or pulling unrelated candidates into the
 * Jev request.
 */
const TOKEN_ALIASES: Record<string, string[]> = {
  // Email and messaging.
  mail: ["email"], inbox: ["email"], thread: ["email"], threads: ["email"],
  message: ["email"], messages: ["email"], reply: ["email"], replies: ["email"],
  compose: ["email"], draft: ["email"], drafts: ["email"],

  // Scheduling.
  schedule: ["calendar"], scheduled: ["calendar"], appointment: ["calendar"],
  meeting: ["calendar"], meetings: ["calendar"], event: ["calendar"], events: ["calendar"],
  availability: ["calendar"],

  // Organizations and people.
  firm: ["company"], business: ["company"], organization: ["company"], organizations: ["company"],
  org: ["company"], corporation: ["company"], corporate: ["company"], enterprise: ["company"],
  people: ["person", "contact"], persons: ["person", "contact"], contacts: ["person", "contact"],
  prospect: ["lead", "contact"], prospects: ["lead", "contact"], lead: ["contact"], leads: ["lead", "contact"],
  customer: ["contact"], customers: ["contact"], client: ["contact"], clients: ["contact"],

  // Search, research, and public-web extraction.
  investigate: ["research"], investigation: ["research"], researching: ["research"],
  lookup: ["search"], lookups: ["search"], find: ["search"], searching: ["search"],
  discover: ["search"], discovery: ["search"],
  scrape: ["extract"], scraping: ["extract"], crawl: ["extract"], crawling: ["extract"],
  parse: ["extract"], parsing: ["extract"], extraction: ["extract"], webpage: ["extract"],

  // Files and documents.
  files: ["file"], document: ["file"], documents: ["file"], doc: ["file"], docs: ["file"],
  attachment: ["file"], attachments: ["file"], upload: ["file"], uploads: ["file"],
  download: ["file"], downloads: ["file"],

  // Development and project work.
  coding: ["code"], repository: ["code"], repositories: ["code"], repo: ["code"], repos: ["code"],
  commit: ["code"], commits: ["code"], branch: ["code"], branches: ["code"],

  // Finance and support operations.
  bill: ["billing"], bills: ["billing"], invoice: ["billing"], invoices: ["billing"],
  payment: ["billing"], payments: ["billing"], transaction: ["billing"], transactions: ["billing"],
  expense: ["billing"], expenses: ["billing"], receipt: ["billing"], receipts: ["billing"],
  ticket: ["support"], tickets: ["support"], helpdesk: ["support"], incident: ["support"], incidents: ["support"],
};

function words(value: string): Set<string> {
  const result = new Set<string>();
  for (const word of value.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 2)) {
    result.add(word);
    for (const alias of TOKEN_ALIASES[word] ?? []) result.add(alias);
  }
  return result;
}

function candidateScore(query: string, candidate: Candidate): number {
  const request = words(query);
  const text = words(`${candidate.id} ${candidate.description} ${(candidate.aliases ?? []).join(" ")} ${(candidate.capabilities ?? []).join(" ")}`);
  let score = 0;
  for (const word of request) if (text.has(word)) score += 1;
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedId = candidate.id.toLowerCase().replace(/^chuck_/, "").replace(/[_-]+/g, " ").trim();
  if (normalizedId && normalizedQuery.includes(normalizedId)) score += 12;
  return score;
}

function explicitCandidateIds(query: string, candidates: Candidate[]): Set<string> {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return new Set(candidates.filter((candidate) => {
    const id = candidate.id.toLowerCase().replace(/^chuck_/, "").replace(/[_-]+/g, " ").trim();
    // Aliases improve recall but are intentionally not treated as explicit
    // invocations; broad aliases such as "live data" appear on many tools.
    return Boolean(id && normalized.includes(id));
  }).map((candidate) => candidate.id));
}

function compactCandidates(query: string, candidates: Candidate[], limit: number, explicit: ReadonlySet<string> = new Set()): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!candidate.id || unique.has(candidate.id)) continue;
    unique.set(candidate.id, {
      id: candidate.id,
      description: jevText(candidate.description, 700) || candidate.id,
      ...(candidate.aliases?.length ? { aliases: candidate.aliases.slice(0, 12) } : {}),
      ...(candidate.capabilities?.length ? { capabilities: candidate.capabilities.slice(0, 24) } : {}),
    });
  }
  return [...unique.values()]
    .sort((a, b) => (explicit.has(b.id) ? 1 : 0) - (explicit.has(a.id) ? 1 : 0) || candidateScore(query, b) - candidateScore(query, a) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
}

function noulCandidate(candidate: Candidate, question: string, criteria: { true: string; false: string }): JevQuestion {
  return {
    type: "noul",
    instructions: {
      candidate: { id: candidate.id, description: candidate.description },
      question,
      decision_rules: "Assess this candidate independently using only the supplied request and description. Do not infer availability, authorization, safety, or successful execution.",
    },
    criteria,
  };
}

function answerNoul(result: JevResult, key: string): number {
  const answer = result.answers[key] as JevNoulAnswer | undefined;
  return answer?.type === "noul" ? answer.noul : 0;
}

function answerChoice(result: JevResult, key: string): JevChoiceAnswer | undefined {
  const answer = result.answers[key] as JevChoiceAnswer | undefined;
  return answer?.type === "choice" ? answer : undefined;
}

function domainCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const route of composioDomainCatalog()) criteria[route.domain] = `${route.domain}: ${route.terms.join(", ")} (apps such as ${route.toolkits.join(", ")})`;
  criteria[NONE_OPTION] = "None of these business domains, or no connected app is involved.";
  return criteria;
}

function connectedToolkitDescription(toolkit: string): string {
  const family = composioDomainCatalog().find((route) => route.toolkits.some((candidate) => toolkitKey(candidate) === toolkitKey(toolkit)));
  if (!family) return `Connected Composio toolkit: ${toolkit}. Use only when its exact action catalogue supports the request.`;
  return `Connected Composio toolkit: ${toolkit}; domain ${family.domain}; capabilities ${family.terms.slice(0, 8).join(", ")}; exact action schema must be loaded before execution.`;
}

function externalBackendCriteria(includeTreg: boolean, includeMonid: boolean): Record<string, string> {
  const criteria: Record<string, string> = {};
  if (includeTreg) criteria.treg = "Treg: broad live external intelligence, provider catalog comparison, organization-owned tools, enrichment, search, and bounded data resolution.";
  if (includeMonid) criteria.monid = "MonID: public structured-data/API catalog using discover, inspect, and run; prefer when MonID is explicitly requested or Treg lacks the needed coverage.";
  criteria[NONE_OPTION] = "No external data gateway is needed, or connected apps/native capabilities/supplied context are sufficient.";
  return criteria;
}

function buildExternalDataBackend(result: JevResult, query: string): ExternalDataBackendRoute | undefined {
  const answer = answerChoice(result, "external_data_backend");
  if (!answer) return undefined;
  const probability = answer.probabilities[answer.choice] ?? answer.confidence;
  if (answer.confidence < config.jevMinConfidence) return { probability, confidence: answer.confidence, source: "jev", fallbackReason: "low_confidence_backend" };
  if (answer.choice === NONE_OPTION) return { selected: "none", probability, confidence: answer.confidence, source: "jev" };
  if (answer.choice !== "treg" && answer.choice !== "monid") return { probability, confidence: answer.confidence, source: "jev", fallbackReason: "invalid_backend_choice" };
  const supportingSignal = answer.choice === "treg" ? answerNoul(result, "treg_live_data") : answerNoul(result, "monid_needed");
  const explicitMonid = answer.choice === "monid" && /\bmonid\b/i.test(query);
  if (supportingSignal < 0.5 && !explicitMonid) return { selected: "none", probability, confidence: answer.confidence, source: "jev", fallbackReason: "backend_signal_disagrees" };
  return { selected: answer.choice, probability, confidence: answer.confidence, source: "jev" };
}

function buildComposioStage1(
  query: string,
  accounts: Array<{ toolkit: string; status?: string }>,
  result: JevResult,
  toolkitCandidates: string[],
): ComposioDecision {
  const connected = activeToolkits(accounts);
  const connectedSet = new Set(connected.map(toolkitKey));
  const needsAppAnswer = answerNoul(result, "composio_needs_app");
  const domainAnswer = answerChoice(result, "composio_domain");
  const toolkits = toolkitCandidates
    .map((id, index) => ({ id, probability: answerNoul(result, `composio_toolkit_${index}`), connected: connectedSet.has(toolkitKey(id)) }))
    .filter((item) => item.probability > 0)
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const selected = toolkits.filter((item) => item.probability >= config.jevToolkitMinProbability).slice(0, 2);
  const strongestToolkit = toolkits[0]?.probability ?? 0;
  const needsApp = Math.max(needsAppAnswer, strongestToolkit);
  if (needsApp < APP_NEEDED_THRESHOLD) {
    return {
      source: "jev",
      noAppNeeded: true,
      toolkits: [],
      unconnectedToolkits: [],
      actions: [],
      directTools: [],
      needsAppAction: needsApp,
      telemetry: { latencyMs: result.latencyMs, costUsd: result.costUsd ?? 0, calls: 1 },
    };
  }

  const domain = domainAnswer && domainAnswer.choice !== NONE_OPTION && domainAnswer.confidence >= config.jevMinConfidence
    ? domainAnswer.choice as ComposioDomain
    : undefined;
  const family = domain ? composioDomainCatalog().find((item) => item.domain === domain) : undefined;
  const selectedIds = selected.map((item) => item.id);
  const familyConnected = (family?.toolkits ?? []).filter((toolkit) => connectedSet.has(toolkitKey(toolkit)));
  const active = selectedIds.length ? selected.filter((item) => item.connected).map((item) => item.id) : familyConnected;
  const inferredDomain = domain ?? composioDomainCatalog().find((item) => item.toolkits.some((toolkit) => selectedIds.some((id) => toolkitKey(id) === toolkitKey(toolkit))))?.domain;
  const route = inferredDomain
    ? {
      domain: inferredDomain,
      preferredToolkits: [...new Set([...selectedIds, ...(composioDomainCatalog().find((item) => item.domain === inferredDomain)?.toolkits ?? [])])],
      connectedToolkits: active,
      needsConnection: needsApp >= 0.5 && (selected[0] ? !selected[0].connected : !active.length),
    }
    : resolveComposioRoute(query, connected);
  return {
    source: "jev",
    ...(route ? { route } : {}),
    toolkits: toolkits.slice(0, 5),
    unconnectedToolkits: [],
    actions: [],
    directTools: [],
    needsAppAction: needsApp,
    telemetry: { latencyMs: result.latencyMs, costUsd: result.costUsd ?? 0, calls: 1 },
  };
}

function buildSkillRoute(
  query: string,
  skills: Array<{ name: string; description: string }>,
  result: JevResult,
  candidateSkills: Candidate[],
): SkillRoute {
  const explicit = explicitlyNamedSkills(query, skills.map((skill) => skill.name));
  const scores: Record<string, number> = {};
  candidateSkills.forEach((candidate, index) => { scores[candidate.id] = answerNoul(result, `skill_${index}`); });
  const ranked = candidateSkills.map((candidate) => ({ id: candidate.id, probability: scores[candidate.id] ?? 0 })).sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const verified = ranked.filter((item) => item.probability >= config.jevSkillVerifyThreshold);
  const jevPrimary = verified.slice(0, 2).map((item) => item.id);
  const primary = [...new Set([...explicit, ...jevPrimary])];
  const supporting = verified.map((item) => item.id).filter((id) => !primary.includes(id)).slice(0, Math.max(0, 4 - primary.length));
  return {
    binding: { primary, supporting },
    source: "jev",
    allowSearchFallback: false,
    ranked: ranked.slice(0, 8),
    verified: scores,
    telemetry: { latencyMs: result.latencyMs, costUsd: result.costUsd ?? 0 },
    ...(primary.length ? {} : { fallbackReason: "no_relevant_skill" }),
  };
}

function buildTregRoute(result: JevResult): TregTurnRoute {
  const tool = answerChoice(result, "treg_tool");
  const liveData = answerNoul(result, "treg_live_data");
  const probability = tool?.probabilities[tool.choice] ?? tool?.confidence ?? 0;
  const fallbackReason = !tool || tool.choice === NONE_OPTION ? "jev_none" : liveData < 0.5 ? "no_live_data_needed" : tool.confidence < config.jevMinConfidence ? "low_confidence" : undefined;
  return { ...(fallbackReason ? {} : { tool: tool!.choice }), probability, needsLiveData: liveData, ...(fallbackReason ? { fallbackReason } : {}) };
}

function buildMonidRoute(result: JevResult, candidates: Candidate[], query: string): MonidTurnRoute {
  const needed = Math.max(answerNoul(result, "monid_needed"), /\bmonid\b/i.test(query) ? 1 : 0);
  const ranked = candidates
    .map((candidate, index) => ({ id: candidate.id, probability: answerNoul(result, `monid_tool_${index}`) }))
    .filter((item) => item.probability >= config.jevNativeToolMinProbability)
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const selected = needed >= APP_NEEDED_THRESHOLD ? ranked.slice(0, 8).map((item) => item.id) : [];
  const fallbackReason = needed < APP_NEEDED_THRESHOLD
    ? "jev_monid_not_needed"
    : selected.length ? undefined : "no_monid_tool_selected";
  return {
    needed,
    selected,
    source: "jev",
    ...(fallbackReason ? { fallbackReason } : {}),
    telemetry: { latencyMs: result.latencyMs, costUsd: result.costUsd ?? 0 },
  };
}

function recordPlanSurface(surface: "skills" | "composio_toolkit" | "treg_tool" | "monid_tool" | "external_data_backend" | "native_tool" | "turn_action", result: JevResult, model: string, applied = true, jev?: Array<{ id: string; p: number }>, extra: Record<string, unknown> = {}): void {
  const costShare = result.costUsd === undefined ? undefined : result.costUsd / 5;
  recordDecision({ surface, mode: "enforce", applied, ...(jev ? { jev } : {}), latencyMs: result.latencyMs, ...(costShare === undefined ? {} : { costUsd: costShare }), model, ...(extra as any) });
}

/** Evaluate all independent turn-routing judgments in one Jev request. */
export async function computeTurnRoutingPlan(input: TurnRoutingPlanInput): Promise<TurnRoutingPlan> {
  const client = input.client ?? jevClient();
  if (!client.available()) throw new Error("Jev is unavailable for turn routing");
  const query = jevText(input.query, 3_000);
  const accounts = input.connectedAccounts ?? [];
  const skills = input.skills ?? await listSkillSummaries();
  const nativeCandidates = input.nativeCandidates ?? [];
  const active = activeToolkits(accounts);
  const maxCandidates = config.jevTurnPlanMaxCandidates;
  const explicit = new Set(explicitlyNamedSkills(query, skills.map((skill) => skill.name)));
  const skillCandidates = compactCandidates(query, skills.map((skill) => ({ id: skill.name, description: skill.description })), maxCandidates, explicit);
  const nativeCandidatePool = nativeCandidates.map((tool) => ({ id: tool.slug, description: nativeToolCapabilityCard(tool), aliases: tool.aliases, capabilities: tool.capabilities }));
  const monidCandidatePool = nativeCandidatePool.filter((tool) => nativeCandidates.find((candidate) => candidate.slug === tool.id)?.bundle === "monid");
  const nativeCandidateList = compactCandidates(query, nativeCandidatePool, Math.min(config.jevNativeToolMaxCandidates, maxCandidates), explicitCandidateIds(query, nativeCandidatePool));
  const monidCandidateList = compactCandidates(query, monidCandidatePool, Math.min(12, maxCandidates), explicitCandidateIds(query, monidCandidatePool));
  const toolkitCandidates = active.slice(0, maxCandidates);
  const questions: Record<string, JevQuestion> = {};
  if (!input.forceCapability) {
    questions.action_required = {
      type: "noul",
      instructions: "Does the current user request require Chusky to consult or use a specialized skill, native tool, connected app, MCP capability, or live-data provider to produce the requested outcome? Answer yes for current/private data, external state, or an external action; answer no for conversation or reasoning fully supported by supplied context.",
      criteria: { true: "A specialized capability is required.", false: "The request can be answered directly without a specialized capability." },
    };
  }
  if (input.includeSkills && jevEnabled("skills")) {
    skillCandidates.forEach((candidate, index) => {
      questions[`skill_${index}`] = noulCandidate(candidate, "Would loading this skill's instructions materially improve completion of the request?", { true: "The skill's procedures or domain guidance directly apply.", false: "The skill is unrelated, redundant, or matches only incidental words." });
    });
  }
  if (input.includeNative && config.jevNativeToolRouting && jevEnabled("native")) {
    nativeCandidateList.forEach((candidate, index) => {
      questions[`native_${index}`] = noulCandidate(candidate, "Would exposing this native tool to the main agent materially help complete the request?", { true: "The tool is necessary or a plausible next step for the requested outcome.", false: "The tool is not directly relevant to the requested outcome." });
    });
  }
  if (input.includeComposio && jevEnabled("composio")) {
    questions.composio_domain = { type: "choice", instructions: "Classify the main business domain needed to fulfill `request`; choose __none__ when no connected-app capability is involved. This is routing only and does not authorize an app action.", criteria: domainCriteria() };
    questions.composio_needs_app = { type: "noul", instructions: "Must Chusky read current data from or change state in a third-party app to complete `request`? Answer yes only when an app is genuinely required; no for general advice, drafting, or work supported by supplied context.", criteria: { true: "A third-party app read or action is required.", false: "No third-party app is required." } };
    toolkitCandidates.forEach((toolkit, index) => {
      questions[`composio_toolkit_${index}`] = noulCandidate({ id: toolkit, description: connectedToolkitDescription(toolkit) }, "Would this connected toolkit materially help complete the request?", { true: "This connected toolkit provides a directly relevant capability.", false: "This toolkit is not directly relevant." });
    });
  }
  if (input.includeTreg && config.tregEnabled && jevEnabled("treg")) {
    questions.treg_tool = { type: "choice", instructions: "Choose the Treg capability that best supplies live external data explicitly needed for `request`; choose __none__ when other capabilities or supplied context are enough. This is a route proposal, not permission to make a paid call.", criteria: { ...TREG_TOOL_CRITERIA, [NONE_OPTION]: "No external live-data provider is needed." } };
    questions.treg_live_data = { type: "noul", instructions: "Does completing `request` require fresh facts from an external data provider about people, companies, websites, markets, or social/ads activity? A yes answer does not authorize spend.", criteria: { true: "External provider data is needed.", false: "No external provider data is needed." } };
  }
  if ((input.includeTreg && config.tregEnabled && jevEnabled("treg")) || (input.includeMonid && config.monidEnabled && jevEnabled("monid"))) {
    questions.external_data_backend = {
      type: "choice",
      instructions: "Choose the single external-data gateway that should be the primary route for this request. Treg and MonID overlap; do not choose both. Choose __none__ when no external data gateway is needed. This proposes routing only and never authorizes spend.",
      criteria: externalBackendCriteria(Boolean(input.includeTreg && config.tregEnabled && jevEnabled("treg")), Boolean(input.includeMonid && config.monidEnabled && jevEnabled("monid"))),
    };
  }
  if (input.includeMonid && config.monidEnabled && jevEnabled("monid")) {
    questions.monid_needed = {
      type: "noul",
      instructions: "Would Monid's live structured-data/API catalogue be the appropriate capability for `request`? Use it when the user explicitly requests Monid or when the request needs a concrete provider/data coverage gap not already covered by Treg, connected apps, native tools, or owner MCPs. This is routing only; it does not authorize spend or a paid run.",
      criteria: { true: "Monid is explicitly requested or fills a concrete coverage gap.", false: "Treg, connected apps, existing native capabilities, or supplied context cover the request; or Monid is unrelated." },
    };
    monidCandidateList.forEach((candidate, index) => {
      questions[`monid_tool_${index}`] = noulCandidate(candidate, "Would this Monid capability materially help complete the request after the existing Treg and connected-app coverage is considered?", { true: "This Monid capability directly supports the request or a concrete coverage gap.", false: "This Monid capability is unrelated, redundant, or would only be speculative." });
    });
  }
  if (!Object.keys(questions).length) throw new Error("No Jev turn-routing questions were enabled");
  const state = {
    request: query,
    ...(input.recentContext ? { recent_conversation: jevText(input.recentContext, 1_200) } : {}),
    ...(active.length ? { connected_toolkits: active } : {}),
  };
  const result = await client.evaluate(state, questions, { signal: input.signal, sessionId: input.sessionId });
  const actionProbability = input.forceCapability ? 1 : answerNoul(result, "action_required");
  const action: TurnActionDecision = input.forceCapability
    ? { noActionNeeded: false, reason: "forced_capability", actionProbability }
    : actionProbability <= NO_ACTION_MAX_PROBABILITY
      ? { noActionNeeded: true, reason: "jev_no_action_needed", actionProbability }
      : { noActionNeeded: false, reason: actionProbability >= 0.5 ? "jev_action_needed" : "jev_uncertain", actionProbability };
  recordPlanSurface("turn_action", result, client.modelId, true, [{ id: action.noActionNeeded ? "__none__" : "__capability_needed__", p: action.noActionNeeded ? 1 - actionProbability : actionProbability }], { noTool: action.noActionNeeded });
  if (action.noActionNeeded) return { action, result };

  const skillRoute = input.includeSkills && jevEnabled("skills") ? buildSkillRoute(query, skills, result, skillCandidates) : undefined;
  if (skillRoute) recordPlanSurface("skills", result, client.modelId, true, (skillRoute.ranked ?? []).map((item) => ({ id: item.id, p: item.probability })), { routeSource: "jev" });
  const nativeToolRoute = input.includeNative && input.availableNativeTools && config.jevNativeToolRouting && jevEnabled("native")
    ? nativeToolRouteFromJevScores(input.availableNativeTools, {
      scores: Object.fromEntries(nativeCandidateList.map((candidate, index) => [candidate.id, answerNoul(result, `native_${index}`)])),
      candidateCount: nativeCandidateList.length,
      query,
      recentContext: input.recentContext,
      preserveAll: input.preserveNativeTools,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
    })
    : undefined;
  if (nativeToolRoute) recordPlanSurface("native_tool", result, client.modelId, nativeToolRoute.source === "jev", nativeToolRoute.telemetry?.ranked?.map((item) => ({ id: item.id, p: item.probability })), { routeSource: nativeToolRoute.source, noNativeTool: nativeToolRoute.noNativeTool });
  const composioStage1 = input.includeComposio && jevEnabled("composio") ? buildComposioStage1(query, accounts, result, toolkitCandidates) : undefined;
  if (composioStage1) recordPlanSurface("composio_toolkit", result, client.modelId, true, composioStage1.toolkits.map((item) => ({ id: item.id, p: item.probability })), { routeSource: "jev" });
  const externalDataBackend = buildExternalDataBackend(result, query);
  if (externalDataBackend) {
    const ranked = Object.entries(answerChoice(result, "external_data_backend")?.probabilities ?? {}).map(([id, p]) => ({ id, p }));
    recordPlanSurface("external_data_backend", result, client.modelId, Boolean(externalDataBackend.selected && externalDataBackend.selected !== "none"), ranked, { selectedRoute: externalDataBackend.selected, ...(externalDataBackend.fallbackReason ? { fallbackReason: externalDataBackend.fallbackReason } : {}) });
  }
  const selectedBackend = externalDataBackend?.selected;
  const tregRoute = input.includeTreg && config.tregEnabled && jevEnabled("treg") && (!externalDataBackend || selectedBackend === "treg") ? buildTregRoute(result) : undefined;
  if (tregRoute) recordPlanSurface("treg_tool", result, client.modelId, Boolean(tregRoute.tool), tregRoute.tool ? [{ id: tregRoute.tool, p: tregRoute.probability }] : undefined);
  const monidRoute = input.includeMonid && config.monidEnabled && jevEnabled("monid") && (!externalDataBackend || selectedBackend === "monid") ? buildMonidRoute(result, monidCandidateList, query) : undefined;
  if (monidRoute) {
    const ranked = monidCandidateList.map((candidate, index) => ({ id: candidate.id, p: answerNoul(result, `monid_tool_${index}`) }));
    recordPlanSurface("monid_tool", result, client.modelId, Boolean(monidRoute.selected.length), ranked, { needed: monidRoute.needed, ...(monidRoute.fallbackReason ? { fallbackReason: monidRoute.fallbackReason } : {}) });
  }
  return { action, skillRoute, nativeToolRoute, composioDecision: composioStage1, composioStage1, tregRoute, monidRoute, externalDataBackend, result };
}
