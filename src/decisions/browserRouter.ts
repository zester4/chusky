import { config } from "../config.js";
import { awaitRoute, jevClient, jevEnabled, NONE_OPTION, rankOptions, type JevClient } from "./jev.js";
import { recordDecision } from "./telemetry.js";
import type { BrowserCandidate, BrowserObservation } from "../vault/browserObservation.js";

export type BrowserDecision = {
  source: "jev" | "deterministic";
  mode: "off" | "shadow" | "enforce";
  candidate?: BrowserCandidate;
  confidence: number;
  fallbackReason?: string;
};

function deterministic(observation: BrowserObservation, reason?: string): BrowserDecision {
  const candidate = observation.candidates.find((item) => item.kind === "reinspect")
    ?? observation.candidates.find((item) => item.kind === "find" && !item.requiresApproval)
    ?? observation.candidates.find((item) => item.kind === "invoke" && !item.requiresApproval)
    ?? observation.candidates.find((item) => item.kind === "handoff")
    ?? observation.candidates.find((item) => item.kind === "stop");
  return { source: "deterministic", mode: config.jevMode, ...(candidate ? { candidate } : {}), confidence: 1, ...(reason ? { fallbackReason: reason } : {}) };
}

export async function routeBrowserNext(input: { observation: BrowserObservation; client?: JevClient; signal?: AbortSignal; sessionId?: string }): Promise<BrowserDecision> {
  const mode = config.jevMode;
  const baseline = deterministic(input.observation);
  if (mode === "off" || !jevEnabled("browser")) return { ...baseline, mode, ...(mode === "off" ? {} : { fallbackReason: "browser_surface_disabled_or_key_missing" }) };
  const options = input.observation.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description }));
  const run = rankOptions(input.client ?? jevClient(), {
    state: { goal: input.observation.goal, page: { origin: input.observation.origin, path: input.observation.path, title: input.observation.title, loadState: input.observation.loadState, sessionStatus: input.observation.sessionStatus }, candidates: input.observation.candidates.map(({ id, kind, role, name, action, risk, description, requiresApproval }) => ({ id, kind, role, name, action, risk, description, requiresApproval })) },
    instructions: "Choose the next bounded browser step for this goal. Select only a candidate from the inspected page. Do not invent selectors, coordinates, URLs, credentials, or approvals. Prefer reinspection when the page is ambiguous and stop or handoff when a human challenge or high-impact action is present.",
    options,
    noneDescription: "No safe next step is clear; stop and let the supervisor handle recovery.",
    signal: input.signal,
    sessionId: input.sessionId,
    maxPerQuestion: 24,
  });
  const result = await awaitRoute(run, Math.max(1, Math.min(config.jevTurnBudgetMs, config.jevTimeoutMs + 100)));
  if (!result.value) {
    recordDecision({ surface: "browser", mode, applied: false, fallbackReason: result.failure ?? "unavailable", baseline: baseline.candidate ? [baseline.candidate.id] : [] });
    return { ...baseline, mode, fallbackReason: result.failure ?? "unavailable" };
  }
  if (mode === "shadow") {
    recordDecision({ surface: "browser", mode, applied: false, baseline: baseline.candidate ? [baseline.candidate.id] : [], jev: result.value.ranked.slice(0, 6).map((item) => ({ id: item.id, p: item.probability })), latencyMs: result.value.latencyMs, costUsd: result.value.costUsd, model: input.client?.modelId });
    return { ...baseline, mode, fallbackReason: "shadow_mode" };
  }
  if (result.value.none >= result.value.confidence) {
    const decision = { ...baseline, mode, fallbackReason: "jev_none" };
    recordDecision({ surface: "browser", mode, applied: false, fallbackReason: decision.fallbackReason, jev: result.value.ranked.slice(0, 6).map((item) => ({ id: item.id, p: item.probability })), baseline: baseline.candidate ? [baseline.candidate.id] : [], latencyMs: result.value.latencyMs, costUsd: result.value.costUsd, model: input.client?.modelId });
    return decision;
  }
  const ranked = result.value.ranked[0];
  const selected = ranked && ranked.probability >= config.jevMinConfidence ? input.observation.candidates.find((candidate) => candidate.id === ranked.id) : undefined;
  const applied = Boolean(selected && !selected.requiresApproval);
  const decision: BrowserDecision = selected && (applied || selected.kind === "reinspect" || selected.kind === "handoff" || selected.kind === "stop")
    ? { source: "jev", mode, candidate: selected, confidence: ranked?.probability ?? result.value.confidence }
    : { ...baseline, mode, fallbackReason: selected?.requiresApproval ? "high_impact_candidate_requires_existing_approval_gate" : "low_confidence_or_no_safe_candidate" };
  recordDecision({ surface: "browser", mode, applied: decision.source === "jev", fallbackReason: decision.fallbackReason, jev: result.value.ranked.slice(0, 6).map((item) => ({ id: item.id, p: item.probability })), baseline: baseline.candidate ? [baseline.candidate.id] : [], latencyMs: result.value.latencyMs, costUsd: result.value.costUsd, model: input.client?.modelId });
  return decision;
}

export function browserDecisionForCandidate(observation: BrowserObservation, candidateId: string): BrowserCandidate {
  const candidate = observation.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error("Browser candidate is no longer present; re-inspect the page");
  return candidate;
}

export { NONE_OPTION };
