import { logger } from "../logger.js";

export type DecisionSurface = "skills" | "composio_toolkit" | "composio_action" | "treg_tool" | "treg_endpoint" | "autonomy";

type SurfaceStats = { decisions: number; applied: number; fallbacks: number; agreements: number; comparisons: number; latencyMsTotal: number; costUsdTotal: number };

const stats = new Map<DecisionSurface, SurfaceStats>();

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
  }, "Jev routing decision");
}

export function jevRoutingStats(): Record<string, SurfaceStats & { meanAgreement?: number; meanLatencyMs?: number }> {
  const out: Record<string, SurfaceStats & { meanAgreement?: number; meanLatencyMs?: number }> = {};
  for (const [surface, value] of stats) {
    out[surface] = {
      ...value,
      ...(value.comparisons ? { meanAgreement: value.agreements / value.comparisons } : {}),
      ...(value.decisions ? { meanLatencyMs: value.latencyMsTotal / value.decisions } : {}),
    };
  }
  return out;
}

export function resetJevRoutingStats(): void { stats.clear(); }
