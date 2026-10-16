import { logger } from "../logger.js";

export type DecisionSurface = "skills" | "composio_toolkit" | "composio_action" | "treg_tool" | "treg_endpoint" | "monid_tool" | "external_data_backend" | "autonomy" | "browser" | "memory" | "native_tool" | "turn_action" | "turn_mode";

type SurfaceStats = { decisions: number; applied: number; fallbacks: number; agreements: number; comparisons: number; latencyMsTotal: number; costUsdTotal: number };

const stats = new Map<DecisionSurface, SurfaceStats>();
type RouteOutcomeSurface = "treg" | "monid";
type RouteOutcome = "success" | "pending" | "failure";
const routeOutcomes = new Map<RouteOutcomeSurface, { attempts: number; successes: number; pending: number; failures: number; latencyMsTotal: number }>();

function bucket(surface: DecisionSurface): SurfaceStats {
  let current = stats.get(surface);
  if (!current) { current = { decisions: 0, applied: 0, fallbacks: 0, agreements: 0, comparisons: 0, latencyMsTotal: 0, costUsdTotal: 0 }; stats.set(surface, current); }
  return current;
}

/**
 * Record one routing decision. Only identifiers, probabilities, and timings
 * are logged; user text, tool arguments, and provider payloads never are.
 */
export function recordDecision(input: {
  surface: DecisionSurface;
  mode: "shadow" | "enforce";
  applied: boolean;
  fallbackReason?: string;
  jev?: Array<{ id: string; p: number }>;
  baseline?: string[];
  latencyMs?: number;
  costUsd?: number;
  model?: string;
  routeSource?: "jev" | "fallback";
  exposedTools?: number;
  baselineTools?: number;
  exposedNativeTools?: number;
  baselineNativeTools?: number;
  loading?: "full" | "bundle";
  preserveAll?: boolean;
  noTool?: boolean;
  noNativeTool?: boolean;
  selectedRoute?: string;
  candidateCount?: number;
}): void {
  const current = bucket(input.surface);
  current.decisions += 1;
  if (input.applied) current.applied += 1;
  if (input.fallbackReason) current.fallbacks += 1;
  current.latencyMsTotal += input.latencyMs ?? 0;
  current.costUsdTotal += input.costUsd ?? 0;
  let agreement: number | undefined;
  if (input.baseline && input.jev) {
    const jevTop = new Set(input.jev.slice(0, Math.max(1, input.baseline.length)).map((item) => item.id));
    const base = new Set(input.baseline);
    const union = new Set([...jevTop, ...base]);
    agreement = union.size ? [...jevTop].filter((id) => base.has(id)).length / union.size : 1;
    current.comparisons += 1;
    current.agreements += agreement;
  }
  logger.info({
    event: `jev.${input.mode}`,
    surface: input.surface,
    applied: input.applied,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    ...(input.jev ? { jev: input.jev.slice(0, 6).map((item) => ({ id: item.id.slice(0, 120), p: Math.round(item.p * 1000) / 1000 })) } : {}),
    ...(input.baseline ? { baseline: input.baseline.slice(0, 6) } : {}),
    ...(agreement === undefined ? {} : { agreement: Math.round(agreement * 1000) / 1000 }),
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
    ...(input.model ? { model: input.model } : {}),
    ...(input.routeSource ? { routeSource: input.routeSource } : {}),
    ...(input.exposedTools === undefined ? {} : { exposedTools: input.exposedTools }),
    ...(input.baselineTools === undefined ? {} : { baselineTools: input.baselineTools }),
    ...(input.exposedNativeTools === undefined ? {} : { exposedNativeTools: input.exposedNativeTools }),
    ...(input.baselineNativeTools === undefined ? {} : { baselineNativeTools: input.baselineNativeTools }),
    ...(input.loading ? { loading: input.loading } : {}),
    ...(input.preserveAll === undefined ? {} : { preserveAll: input.preserveAll }),
    ...(input.noTool === undefined ? {} : { noTool: input.noTool }),
    ...(input.noNativeTool === undefined ? {} : { noNativeTool: input.noNativeTool }),
    ...(input.selectedRoute ? { selectedRoute: input.selectedRoute } : {}),
    ...(input.candidateCount === undefined ? {} : { candidateCount: input.candidateCount }),
  }, "Jev routing decision");
}

/** Record the bounded result of a routed gateway execution without payloads. */
export function recordRouteOutcome(input: {
  surface: RouteOutcomeSurface;
  route: string;
  outcome: RouteOutcome;
  latencyMs: number;
  errorClass?: string;
}): void {
  const current = routeOutcomes.get(input.surface) ?? { attempts: 0, successes: 0, pending: 0, failures: 0, latencyMsTotal: 0 };
  current.attempts += 1;
  current.latencyMsTotal += Math.max(0, input.latencyMs);
  if (input.outcome === "success") current.successes += 1;
  else if (input.outcome === "pending") current.pending += 1;
  else current.failures += 1;
  routeOutcomes.set(input.surface, current);
  logger.info({
    event: "jev.route_outcome",
    surface: input.surface,
    route: input.route.slice(0, 120),
    outcome: input.outcome,
    latencyMs: Math.max(0, input.latencyMs),
    ...(input.errorClass ? { errorClass: input.errorClass.slice(0, 80) } : {}),
  }, "Jev routed gateway outcome");
}

export function recordTurnMode(input: {
  mode: "conversational" | "action";
  reason: string;
  noNativeTool: boolean;
  skillsRouted: boolean;
  tregRouted: boolean;
  composioRouted: boolean;
  promptTokens?: number;
  findToolsCalled?: boolean;
  capabilityFailureReply?: boolean;
}): void {
  logger.info({
    event: "turn.mode",
    mode: input.mode,
    reason: input.reason,
    noNativeTool: input.noNativeTool,
    skillsRouted: input.skillsRouted,
    tregRouted: input.tregRouted,
    composioRouted: input.composioRouted,
    ...(input.promptTokens === undefined ? {} : { promptTokens: input.promptTokens }),
    ...(input.findToolsCalled === undefined ? {} : { findToolsCalled: input.findToolsCalled }),
    ...(input.capabilityFailureReply === undefined ? {} : { capabilityFailureReply: input.capabilityFailureReply }),
  }, "Turn mode telemetry");
}

/** Content-free operational telemetry for a live meeting turn. */
export function recordMeetingTurn(input: {
  interactionMode: "addressed" | "copilot" | "representative";
  toolsUsed?: string[];
  recordsReturned?: boolean;
  verifiedParticipantCount?: number;
}): void {
  logger.info({
    event: "meeting.turn",
    interactionMode: input.interactionMode,
    toolsUsed: (input.toolsUsed ?? []).slice(0, 30).map((tool) => tool.slice(0, 160)),
    recordsReturned: input.recordsReturned === true,
    verifiedParticipantCount: Math.max(0, Math.min(40, Math.floor(input.verifiedParticipantCount ?? 0))),
  }, "Meeting turn telemetry");
}

export function jevRoutingStats(): Record<string, SurfaceStats & { meanAgreement?: number; meanLatencyMs?: number; pending?: number }> {
  const out: Record<string, SurfaceStats & { meanAgreement?: number; meanLatencyMs?: number; pending?: number }> = {};
  for (const [surface, value] of stats) {
    out[surface] = {
      ...value,
      ...(value.comparisons ? { meanAgreement: value.agreements / value.comparisons } : {}),
      ...(value.decisions ? { meanLatencyMs: value.latencyMsTotal / value.decisions } : {}),
    };
  }
  for (const [surface, value] of routeOutcomes) {
    out[`${surface}_outcomes`] = {
      decisions: value.attempts,
      applied: value.successes,
      fallbacks: value.failures,
      agreements: 0,
      comparisons: 0,
      latencyMsTotal: value.latencyMsTotal,
      costUsdTotal: 0,
      pending: value.pending,
      ...(value.attempts ? { meanLatencyMs: value.latencyMsTotal / value.attempts } : {}),
    };
  }
  return out;
}

export function resetJevRoutingStats(): void { stats.clear(); routeOutcomes.clear(); }
