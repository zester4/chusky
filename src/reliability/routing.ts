import type { ReliabilityHealth } from "./contracts.js";

export interface RouteCandidate { id: string; health?: ReliabilityHealth; costMultiplier?: number; latencyMultiplier?: number; }

/** Pick a route using measured reliability first, then latency and cost. */
export function chooseReliableRoute(candidates: readonly RouteCandidate[], options: { requireHealthy?: boolean } = {}): RouteCandidate | undefined {
  const eligible = candidates.filter((candidate) => !options.requireHealthy || !candidate.health || candidate.health.state === "healthy");
  return [...eligible].sort((a, b) => {
    const ar = a.health?.successRate ?? 0.5; const br = b.health?.successRate ?? 0.5;
    if (ar !== br) return br - ar;
    const au = a.health?.uncertaintyRate ?? 0; const bu = b.health?.uncertaintyRate ?? 0;
    if (au !== bu) return au - bu;
    const al = (a.health?.p95LatencyMs ?? 0) * (a.latencyMultiplier ?? 1); const bl = (b.health?.p95LatencyMs ?? 0) * (b.latencyMultiplier ?? 1);
    if (al !== bl) return al - bl;
    return (a.costMultiplier ?? 1) - (b.costMultiplier ?? 1);
  })[0];
}
