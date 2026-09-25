import { getSession } from "../store.js";
import type { QuotaDecision } from "./contracts.js";

export interface QuotaLimits { maxCallsPerDay?: number; maxCostUsdPerDay?: number; maxConcurrent?: number; }

/** Durable, owner-scoped quota decision used before starting an external run. */
export async function checkExecutionQuota(ownerId: number, operation: string, limits: QuotaLimits = {}, now = Date.now()): Promise<QuotaDecision> {
  const session = await getSession(ownerId);
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  const samples = (session.reliabilitySamples ?? []).filter((item) => item.ownerId === ownerId && item.operation === operation && item.at >= dayStart);
  const toolCalls = samples.length;
  const cost = samples.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  const concurrent = session.sdkThreads?.reduce((sum, thread) => sum + thread.runs.filter((run) => run.status === "running").length, 0) ?? 0;
  const maxCalls = Math.max(1, Math.floor(limits.maxCallsPerDay ?? 1000));
  const maxCost = Math.max(0, limits.maxCostUsdPerDay ?? 100);
  const maxConcurrent = Math.max(1, Math.floor(limits.maxConcurrent ?? 4));
  const remaining = { toolCalls: Math.max(0, maxCalls - toolCalls), costUsd: Math.max(0, maxCost - cost), concurrent: Math.max(0, maxConcurrent - concurrent) };
  if (toolCalls >= maxCalls) return { allowed: false, reason: "Daily execution quota reached.", remaining };
  if (cost >= maxCost) return { allowed: false, reason: "Daily cost quota reached.", remaining };
  if (concurrent >= maxConcurrent) return { allowed: false, reason: "Concurrent execution quota reached.", remaining };
  return { allowed: true, remaining };
}
