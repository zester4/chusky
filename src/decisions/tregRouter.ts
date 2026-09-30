/**
 * Treg routing.
 *
 *  1. Turn level: which native Treg tool fits the request (enrich person,
 *     enrich company, bounded resolve, catalog search, ...), or none. The
 *     result is a short model-facing hint, never an automatic call.
 *  2. Endpoint level: when the gateway has candidate catalog endpoints, Jev
 *     scores how well each endpoint fits the job. The gateway blends that fit
 *     with its deterministic price, reliability, latency, and input-coverage
 *     score. Spend reservations, BYOK/own-account filters, and budgets remain
 *     in code and are never overridden.
 */
import { config } from "../config.js";
import type { TregEndpointHit } from "../treg/types.js";
import { NONE_OPTION, awaitRoute, jevClient, jevEnabled, jevText, type JevChoiceAnswer, type JevClient, type JevNoulAnswer, type RoutingDeadline } from "./jev.js";
import { recordDecision } from "./telemetry.js";

export const TREG_TOOL_CRITERIA: Record<string, string> = {
  CHUCK_TREG_ENRICH_PERSON: "Find live data about a specific person: work email, title, company, domain, or profile URL.",
  CHUCK_TREG_ENRICH_COMPANY: "Find live firmographic data about a specific company by domain or name: industry, headcount, website, description.",
  CHUCK_TREG_RESOLVE: "Answer a bounded external data need that requires calling one or more live data providers and returning sourced fields.",
  CHUCK_TREG_SEARCH: "Discover which live external data providers exist for a capability (SEO, social, ads, web data, market data, voice, video).",
  CHUCK_TREG_PLATFORMS: "Compare several providers for one capability by inputs, reliability, speed, and price.",
  CHUCK_TREG_MY_TOOLS: "Use or inspect an HTTP tool registered by the user's own organization.",
  CHUCK_TREG_BALANCE: "Check the Treg provider balance.",
  CHUCK_TREG_USAGE: "Review Chusky's Treg spend, reservations, and call receipts.",
};

export type TregTurnRoute = { tool?: string; probability: number; needsLiveData: number; fallbackReason?: string };

export async function computeTregTurnRoute(objective: string, options: { client?: JevClient; signal?: AbortSignal; sessionId?: string } = {}): Promise<TregTurnRoute> {
  const client = options.client ?? jevClient();
  const result = await client.evaluate({ request: jevText(objective, 3_000) }, {
    tool: {
      type: "choice",
      instructions: "Which live external-data tool should the assistant use first for `request`?",
      criteria: { ...TREG_TOOL_CRITERIA, [NONE_OPTION]: "No external live-data provider is needed; use connected apps, memory, or general knowledge." },
    },
    live_data: {
      type: "noul",
      instructions: "Does `request` need fresh data about people, companies, websites, markets, or social/ads activity from an external data provider?",
      criteria: { true: "External provider data is needed.", false: "No external provider data is needed." },
    },
  }, { signal: options.signal, sessionId: options.sessionId });
  const tool = result.answers.tool as JevChoiceAnswer;
  const liveData = (result.answers.live_data as JevNoulAnswer).noul;
  const fallbackReason = tool.choice === NONE_OPTION ? "jev_none" : liveData < 0.5 ? "no_live_data_needed" : tool.confidence < config.jevMinConfidence ? "low_confidence" : undefined;
  const applied = config.jevMode === "enforce" && !fallbackReason;
  recordDecision({ surface: "treg_tool", mode: config.jevMode === "enforce" ? "enforce" : "shadow", applied, ...(fallbackReason ? { fallbackReason } : {}), jev: [{ id: tool.choice, p: tool.probabilities[tool.choice] ?? tool.confidence }], latencyMs: result.latencyMs, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }), model: client.modelId });
  if (fallbackReason) return { probability: tool.probabilities[tool.choice] ?? 0, needsLiveData: liveData, fallbackReason };
  return { tool: tool.choice, probability: tool.probabilities[tool.choice] ?? tool.confidence, needsLiveData: liveData };
}

export function tregTurnContext(route: TregTurnRoute | undefined): string {
  if (!route?.tool) return "";
  return `Treg route: ${route.tool} (p=${route.probability.toFixed(2)}) fits this request. Use it for live external data with the inputs already known; inspect price with CHUCK_TREG_GET before a paid CHUCK_TREG_CALL. Budgets and approvals are unchanged.`;
}

/** Enforce-mode turn hint; shadow mode records the decision and returns nothing. */
export async function routeTregForTurn(objective: string, options: { client?: JevClient; signal?: AbortSignal; sessionId?: string; budgetMs?: number; deadline?: RoutingDeadline } = {}): Promise<TregTurnRoute | undefined> {
  if (!config.tregEnabled || !objective.trim() || !jevEnabled("treg")) return undefined;
  const client = options.client ?? jevClient();
  if (!client.available()) return undefined;
  const enforce = config.jevMode === "enforce";
  const run = computeTregTurnRoute(objective, { ...options, client, signal: enforce && options.deadline ? options.deadline.signal : options.signal });
  if (!enforce) { run.catch(() => undefined); return undefined; }
  return (await awaitRoute(run, options.deadline ? options.deadline.remaining() : options.budgetMs ?? config.jevTurnBudgetMs)).value;
}

export type TregEndpointJudgeInput = { intent: string; need: string; hits: TregEndpointHit[]; availableFields?: string[]; requiredFields?: string[] };
/** Returns fit probability per endpoint id (0..1), or undefined to keep deterministic ranking. */
export type TregEndpointJudge = (input: TregEndpointJudgeInput) => Promise<Record<string, number> | undefined>;

function describeHit(hit: TregEndpointHit): string {
  return jevText([
    hit.title,
    `provider ${hit.provider}`,
    `category ${hit.category}`,
    hit.inputFields?.length ? `inputs ${hit.inputFields.slice(0, 12).join(", ")}` : "",
    hit.priceUsd === undefined ? "" : `price $${hit.priceUsd}`,
    hit.successRate === undefined ? "" : `success ${Math.round(hit.successRate * 100)}%`,
    /bulk|batch/i.test(`${hit.id} ${hit.title}`) ? "mode: bulk" : /status|job|async/i.test(`${hit.id} ${hit.title}`) ? "mode: asynchronous job" : "",
  ].filter(Boolean).join("; "), 360);
}

/**
 * Jev endpoint judge. One Choice over the candidate endpoints gives a
 * comparable task-fit distribution. The endpoint mode (synchronous,
 * asynchronous job, bulk) is described neutrally; the judge must not prefer
 * one mode over another. Numbers and ties stay with the gateway.
 */
export function createTregEndpointJudge(options: { client?: JevClient } = {}): TregEndpointJudge {
  return async (input) => {
    if (!jevEnabled("treg") || input.hits.length < 2) return undefined;
    const client = options.client ?? jevClient();
    if (!client.available()) return undefined;
    const hits = input.hits.slice(0, config.jevMaxOptionsPerQuestion);
    const criteria: Record<string, string> = {};
    for (const hit of hits) criteria[hit.id] = describeHit(hit);
    criteria[NONE_OPTION] = "None of these endpoints can do this job.";
    try {
      const result = await client.evaluate({
        job: jevText(input.intent, 200),
        need: jevText(input.need, 1_000),
        available_inputs: input.availableFields ?? [],
        required_output_fields: input.requiredFields ?? [],
      }, {
        endpoint: { type: "choice", instructions: "Which provider endpoint best fits `job` for `need`, returning `required_output_fields` from `available_inputs`? Judge task fit only; synchronous, asynchronous, and bulk endpoints are all valid when their mode suits the need.", criteria },
      });
      const answer = result.answers.endpoint as JevChoiceAnswer;
      const selected = input.hits.find((hit) => hit.id === answer.choice);
      const fallbackReason = answer.choice === NONE_OPTION ? "jev_none" : !selected ? "invalid_endpoint_choice" : answer.confidence < config.jevMinConfidence * 0.5 ? "low_confidence" : undefined;
      if (fallbackReason) {
        recordDecision({ surface: "treg_endpoint", mode: config.jevMode === "enforce" ? "enforce" : "shadow", applied: false, fallbackReason, jev: [{ id: answer.choice, p: answer.probabilities[answer.choice] ?? answer.confidence }], latencyMs: result.latencyMs, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }), model: client.modelId });
        return undefined;
      }
      const fit: Record<string, number> = {};
      for (const hit of hits) fit[hit.id] = answer.probabilities[hit.id] ?? 0;
      const ranked = Object.entries(fit).sort((a, b) => b[1] - a[1]).map(([id, p]) => ({ id, p }));
      const apply = config.jevMode === "enforce";
      recordDecision({ surface: "treg_endpoint", mode: config.jevMode === "enforce" ? "enforce" : "shadow", applied: apply, ...(apply ? {} : { fallbackReason: config.jevMode === "enforce" ? "low_confidence" : "shadow" }), jev: ranked, latencyMs: result.latencyMs, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }), model: client.modelId });
      return apply ? fit : undefined;
    } catch (error) {
      recordDecision({ surface: "treg_endpoint", mode: config.jevMode === "enforce" ? "enforce" : "shadow", applied: false, fallbackReason: (error as { reason?: string })?.reason ?? "error" });
      return undefined;
    }
  };
}
