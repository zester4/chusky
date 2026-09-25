import type { BusinessGap, GapEvidence, NormalizedBusinessSignal } from "./gapDetectors.js";

/** Detects commercial opportunities from provider evidence; it only proposes work. */
export function detectBusinessOpportunities(signals: readonly NormalizedBusinessSignal[], now = Date.now()): BusinessGap[] {
  const output: BusinessGap[] = [];
  for (const signal of signals.slice(0, 500)) {
    const kind = String(signal.kind ?? "").toLowerCase();
    const state = String(signal.status ?? "").toLowerCase();
    const subject = String(signal.subject ?? signal.id ?? signal.kind ?? "Opportunity").slice(0, 180);
    const evidence: GapEvidence[] = [{ source: String(signal.source).slice(0, 120), ...(signal.id ? { recordId: String(signal.id).slice(0, 180) } : {}), summary: `Observed ${kind || "business signal"} with status ${state || "unknown"}.` }];
    if (["lead", "deal", "opportunity", "customer"].includes(kind) && ["qualified", "engaged", "proposal", "interested", "active"].some((value) => state.includes(value))) {
      output.push({ key: `opportunity:expansion:${signal.source}:${signal.id ?? subject}`.toLowerCase(), type: "expansion_opportunity", severity: "medium", title: `Potential expansion: ${subject}`, reason: "A qualified or engaged relationship has a positive commercial signal.", recommendedNextAction: "Review the evidence, prepare a tailored value proposition, and request approval before outbound contact.", requiresApproval: true, evidence, detectedAt: now });
    }
    if (["subscription", "contract", "renewal"].includes(kind) && ["at_risk", "pending", "due", "expiring"].some((value) => state.includes(value))) {
      output.push({ key: `opportunity:renewal:${signal.source}:${signal.id ?? subject}`.toLowerCase(), type: "renewal_risk", severity: "high", title: `Renewal needs attention: ${subject}`, reason: "A contract or subscription appears to be approaching a decision point.", recommendedNextAction: "Verify current contract status and prepare an owner-approved renewal plan.", requiresApproval: true, evidence, detectedAt: now });
    }
  }
  return output.slice(0, 100);
}
