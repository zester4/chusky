import { isReadOnlyToolSlug } from "../policy.js";
import type { OutcomeCheck, OutcomeCheckResult, OutcomeVerification } from "./contracts.js";
import { appendTraceEvent, saveOutcomeVerification } from "./persistence.js";
import { verifyOutcome } from "./evaluator.js";
import { getMission } from "../store.js";

export interface OutcomeReadAdapter {
  read: (input: { toolSlug: string; provider?: string; check: OutcomeCheck }) => Promise<{ observed?: Record<string, unknown>; evidenceRef?: string; provider?: string; observedAt?: number }>;
}

/** Trusted mission evidence must describe verified fields, never model-authored check prose. */
export function verifiedOutcomeEvidenceSummary(check: OutcomeCheck): string {
  const fields = Object.keys(check.expected ?? {})
    .filter((key) => !/token|secret|password|credential|cookie|authorization|private.?key/i.test(key))
    .map((key) => key.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80))
    .filter(Boolean)
    .sort()
    .slice(0, 20);
  return `Provider state verified by ${check.toolSlug ?? "read-only action"}; expected fields matched: ${fields.join(", ")}.`;
}

/** Execute provider-backed checks through a read-only adapter and persist the proof. */
export async function executeOutcomeVerification(input: {
  ownerId: number;
  missionId?: string;
  runId?: string;
  checks: OutcomeCheck[];
  suppliedResults?: OutcomeCheckResult[];
  adapter?: OutcomeReadAdapter;
  maxAttempts?: number;
  now?: number;
}): Promise<OutcomeVerification> {
  const now = input.now ?? Date.now();
  const results: OutcomeCheckResult[] = [];
  const mission = input.missionId ? await getMission(input.ownerId, input.missionId) : undefined;
  for (const check of input.checks.slice(0, 50)) {
    if (!["provider_read", "receipt", "artifact", "human"].includes(check.kind)) {
      results.push({ checkId: check.id, status: "uncertain", reason: "Unsupported check kind; use provider_read, receipt, artifact, or human." });
      continue;
    }
    if (check.kind !== "provider_read") {
      const evidence = mission?.evidence?.find((item) => item.id === check.evidenceId);
      const kinds = check.kind === "receipt" ? ["tool_receipt"] : check.kind === "artifact" ? ["artifact"] : ["human_confirmation"];
      const trustedBy = check.kind === "human" ? "human" : "system";
      if (!evidence || !kinds.includes(evidence.kind) || !evidence.verified || evidence.verifiedBy !== trustedBy
        || !evidence.verifiedAt || evidence.verifiedAt > now || !(evidence.source || evidence.ref || evidence.hash)
        || (check.provider && check.provider !== evidence.source) || (check.toolSlug && check.toolSlug !== evidence.source)) {
        results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "Supply evidenceId referencing a matching trusted record in this owned mission. Agent-authored evidence, other owners' records, and mismatched kinds or sources cannot verify this check." });
        continue;
      }
      results.push({ checkId: check.id, status: "passed", observedAt: evidence.verifiedAt,
        evidenceRef: check.kind === "human" ? `human:${evidence.id}` : `mission-evidence:${evidence.id}`,
        provider: evidence.source, observed: { id: evidence.id, kind: evidence.kind, source: evidence.source, ref: evidence.ref, hash: evidence.hash } });
      continue;
    }
    if (!check.toolSlug || !isReadOnlyToolSlug(check.toolSlug)) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "Provider outcome checks must use a known read-only tool." });
      continue;
    }
    if (!check.expected || typeof check.expected !== "object" || Array.isArray(check.expected) || Object.keys(check.expected).length === 0) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "Provider outcome checks must declare non-empty expected state fields; a read alone does not prove the outcome." });
      continue;
    }
    if (!input.adapter) {
      results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: "No provider read adapter is available in this execution context." });
      continue;
    }
    let lastError = "Provider read failed.";
    const attempts = Math.max(1, Math.min(3, Math.floor(input.maxAttempts ?? 2)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const observed = await input.adapter.read({ toolSlug: check.toolSlug, provider: check.provider, check });
        if (observed.observedAt === undefined || observed.observedAt > now + 30_000) throw new Error("Provider read did not return a trustworthy observation timestamp.");
        results.push({ checkId: check.id, status: "passed", observed: observed.observed, evidenceRef: observed.evidenceRef, provider: observed.provider ?? check.provider, observedAt: observed.observedAt });
        lastError = "";
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
        lastError = `Provider read failed${safeMessage ? `: ${safeMessage}` : " (unknown provider error)"}.`;
      }
    }
    if (lastError) results.push({ checkId: check.id, status: "uncertain", observedAt: now, reason: lastError });
  }
  const verification = verifyOutcome({ ownerId: input.ownerId, missionId: input.missionId, runId: input.runId, checks: input.checks, results, now });
  await saveOutcomeVerification(verification);
  await appendTraceEvent({ ownerId: input.ownerId, kind: "verification", type: "outcome.completed", at: verification.completedAt ?? now, correlationId: input.missionId ?? input.runId, status: verification.status, summary: `Outcome verification ${verification.status}; ${verification.unresolved.length} unresolved check(s).` });
  return verification;
}
