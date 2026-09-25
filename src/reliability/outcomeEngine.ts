import { isReadOnlyToolSlug } from "../policy.js";
import type { OutcomeCheck, OutcomeCheckResult, OutcomeVerification } from "./contracts.js";
import { appendTraceEvent, saveOutcomeVerification } from "./persistence.js";
import { verifyOutcome } from "./evaluator.js";

export interface OutcomeReadAdapter {
  read: (input: { toolSlug: string; provider?: string; check: OutcomeCheck }) => Promise<{ observed?: Record<string, unknown>; evidenceRef?: string; observedAt?: number }>;
}

/** Execute provider-backed checks through a read-only adapter and persist the proof. */
export async function executeOutcomeVerification(input: {
  ownerId: number;
  missionId?: string;
  runId?: string;
  checks: OutcomeCheck[];
  suppliedResults?: OutcomeCheckResult[];
  adapter?: OutcomeReadAdapter;
  now?: number;
}): Promise<OutcomeVerification> {
  const now = input.now ?? Date.now();
  const supplied = new Map((input.suppliedResults ?? []).map((result) => [result.checkId, result]));
  const results: OutcomeCheckResult[] = [];
  for (const check of input.checks.slice(0, 50)) {
    const existing = supplied.get(check.id);
    if (existing && check.kind !== "provider_read") { results.push(existing); continue; }
    if (check.kind !== "provider_read") {
      results.push(existing ?? { checkId: check.id, status: "uncertain", observedAt: now, reason: "This check requires an explicit receipt, artifact, or human confirmation." });
      continue;
    }
    if (!check.toolSlug || !isReadOnlyToolSlug(check.toolSlug)) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "Provider outcome checks must use a known read-only tool." });
      continue;
    }
    if (!input.adapter) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "No provider read adapter is available in this execution context." });
      continue;
    }
    try {
      const observed = await input.adapter.read({ toolSlug: check.toolSlug, provider: check.provider, check });
      results.push({ checkId: check.id, status: "passed", observed: observed.observed, evidenceRef: observed.evidenceRef, observedAt: observed.observedAt ?? now });
    } catch (error) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: error instanceof Error ? error.message.slice(0, 500) : "Provider read failed." });
    }
  }
  const verification = verifyOutcome({ ownerId: input.ownerId, missionId: input.missionId, runId: input.runId, checks: input.checks, results, now });
  await saveOutcomeVerification(verification);
  await appendTraceEvent({ ownerId: input.ownerId, kind: "verification", type: "outcome.completed", at: verification.completedAt ?? now, correlationId: input.missionId ?? input.runId, status: verification.status, summary: `Outcome verification ${verification.status}; ${verification.unresolved.length} unresolved check(s).` });
  return verification;
}
