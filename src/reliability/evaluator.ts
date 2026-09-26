import { createHash, randomUUID } from "node:crypto";
import type { OutcomeCheck, OutcomeCheckResult, OutcomeVerification, QuotaDecision, ReliabilityHealth, ReliabilitySample } from "./contracts.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function sameExpected(observed: Record<string, unknown> | undefined, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  if (!observed) return false;
  return Object.entries(expected).every(([key, value]) => stable(observed[key]) === stable(value));
}

function hasEvidence(result: OutcomeCheckResult, kind: OutcomeCheck["kind"]): boolean {
  if (result.status !== "passed") return false;
  if (kind === "provider_read") return result.observedAt !== undefined && Boolean(result.provider || result.evidenceRef);
  if (kind === "human") return typeof result.evidenceRef === "string" && result.evidenceRef.startsWith("human:");
  return typeof result.evidenceRef === "string" && result.evidenceRef.trim().length > 0;
}

function hasExpectedProviderState(check: OutcomeCheck): boolean {
  return Boolean(check.expected && typeof check.expected === "object" && !Array.isArray(check.expected) && Object.keys(check.expected).length > 0);
}

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 5) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const blocked = /token|secret|password|credential|cookie|authorization|private.?key/i;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 50)
      .map(([key, item]) => [key.slice(0, 100), safeValue(item, depth + 1)]));
  }
  return "[unsupported]";
}

function safeObserved(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return safeValue(value) as Record<string, unknown>;
}

export function verifyOutcome(input: {
  ownerId: number;
  missionId?: string;
  runId?: string;
  checks: OutcomeCheck[];
  results: OutcomeCheckResult[];
  now?: number;
}): OutcomeVerification {
  const now = input.now ?? Date.now();
  const byId = new Map(input.results.map((result) => [result.checkId, result]));
  const unresolved: string[] = [];
  let passed = 0;
  let required = 0;
  for (const check of input.checks) {
    if (check.required !== false) required += 1;
    const result = byId.get(check.id);
    if (!result || result.status === "skipped") {
      if (check.required !== false) unresolved.push(`${check.id}: no result`);
      continue;
    }
    const missingTimestamp = check.kind === "provider_read" && check.freshnessMs !== undefined && result.observedAt === undefined;
    const missingExpected = check.kind === "provider_read" && !hasExpectedProviderState(check);
    const stale = check.freshnessMs !== undefined && result.observedAt !== undefined && (result.observedAt > now + 30_000 || now - result.observedAt > check.freshnessMs);
    if (hasEvidence(result, check.kind) && !missingTimestamp && !missingExpected && !stale && sameExpected(result.observed, check.expected)) passed += check.required === false ? 0 : 1;
    else if (check.required !== false) unresolved.push(`${check.id}: ${missingExpected ? "provider read has no expected state fields" : missingTimestamp ? "evidence timestamp is missing" : stale ? "evidence is stale or from the future" : result.reason || result.status || "failed"}`);
  }
  const status = unresolved.length === 0 && passed >= required ? "verified" : input.results.some((r) => r.status === "uncertain") ? "uncertain" : "failed";
  return {
    id: `verify_${randomUUID()}`,
    ownerId: input.ownerId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    status,
    checks: input.checks.map(({ arguments: _arguments, ...check }) => ({ ...check, id: check.id.slice(0, 160), description: check.description.slice(0, 1000), expected: safeObserved(check.expected) })),
    results: input.results.map((result) => ({ ...result, observed: safeObserved(result.observed), evidenceRef: result.evidenceRef?.slice(0, 300), provider: result.provider?.slice(0, 120), reason: result.reason?.slice(0, 500) })),
    confidence: required === 0 ? 1 : Math.max(0, Math.min(1, passed / required)),
    unresolved,
    startedAt: now,
    completedAt: status === "verified" || status === "failed" ? now : undefined,
    version: 1,
  };
}

export function externalActionId(ownerId: number, sourceId: string, toolSlug: string, args: Record<string, unknown>): string {
  return `action_${createHash("sha256").update(`${ownerId}:${sourceId}:${toolSlug}:${stable(args)}`).digest("hex").slice(0, 48)}`;
}

export function makeQuotaDecision(input: {
  toolCalls: number;
  costUsd: number;
  concurrent: number;
  limits: { maxToolCalls: number; maxCostUsd: number; maxConcurrent: number };
}): QuotaDecision {
  const remaining = {
    toolCalls: Math.max(0, input.limits.maxToolCalls - input.toolCalls),
    costUsd: Math.max(0, input.limits.maxCostUsd - input.costUsd),
    concurrent: Math.max(0, input.limits.maxConcurrent - input.concurrent),
  };
  if (input.toolCalls >= input.limits.maxToolCalls) return { allowed: false, reason: "tool_call_quota_exhausted", remaining };
  if (input.costUsd >= input.limits.maxCostUsd) return { allowed: false, reason: "cost_quota_exhausted", remaining };
  if (input.concurrent >= input.limits.maxConcurrent) return { allowed: false, reason: "concurrency_quota_exhausted", remaining };
  return { allowed: true, remaining };
}

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function assessReliability(samples: readonly ReliabilitySample[], operation: string, now = Date.now(), windowMs = 60 * 60_000): ReliabilityHealth {
  const relevant = samples.filter((sample) => sample.operation === operation && sample.at >= now - windowMs);
  const failures = relevant.filter((sample) => sample.status === "failure" || sample.status === "timeout").length;
  const uncertain = relevant.filter((sample) => sample.status === "uncertain").length;
  const success = relevant.filter((sample) => sample.status === "success").length;
  const successRate = relevant.length ? success / relevant.length : 1;
  const uncertaintyRate = relevant.length ? uncertain / relevant.length : 0;
  const reasons: string[] = [];
  if (relevant.length >= 5 && successRate < 0.7) reasons.push("success_rate_below_70_percent");
  if (relevant.length >= 5 && uncertaintyRate >= 0.2) reasons.push("uncertainty_rate_above_20_percent");
  if (relevant.length >= 3 && failures >= 3) reasons.push("repeated_failures");
  const state = relevant.length >= 5 && (successRate < 0.4 || failures / relevant.length >= 0.6) ? "meltdown" : reasons.length ? "degraded" : "healthy";
  return { operation, windowMs, sampleCount: relevant.length, successRate, uncertaintyRate, p95LatencyMs: percentile(relevant.flatMap((sample) => sample.latencyMs === undefined ? [] : [sample.latencyMs]), 0.95), state, reasons, calculatedAt: now };
}
