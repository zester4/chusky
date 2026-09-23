import { getOutcomePackage, planOutcome, type OutcomePackage } from "../outcomes/catalog.js";
import type { BusinessGap, BusinessGapType } from "./gapDetectors.js";

const outcomeByGap: Record<BusinessGapType, string> = {
  overdue_invoice: "invoice-follow-up",
  unreplied_message: "inbox-response-triage",
  stale_lead: "qualified-fintech-leads",
  staffing_coverage: "staffing-coverage-recovery",
  stalled_onboarding: "stalled-onboarding-recovery",
  missed_follow_up: "post-meeting-follow-through",
};

export interface AutonomyPlaybookPlan {
  gap: BusinessGap;
  outcome: OutcomePackage;
  missingInputs: string[];
  objective: string;
  definitionOfDone: string;
  steps: ReturnType<typeof planOutcome>["steps"];
  approvalBoundary: string;
}

export function playbookSlugForGap(type: BusinessGapType): string { return outcomeByGap[type]; }

export function planBusinessGapPlaybook(gap: BusinessGap, input: Record<string, unknown> = {}): AutonomyPlaybookPlan {
  const slug = playbookSlugForGap(gap.type);
  const outcome = getOutcomePackage(slug);
  if (!outcome) throw new Error(`No playbook is registered for ${gap.type}`);
  const planned = planOutcome(slug, { ...input, gap_key: gap.key, gap_reason: gap.reason, recommended_next_action: gap.recommendedNextAction });
  return { gap, outcome, missingInputs: planned.missingInputs, objective: planned.objective, definitionOfDone: planned.definitionOfDone, steps: planned.steps, approvalBoundary: gap.requiresApproval ? "Prepare and verify; pause before any external write, outbound message, payment, schedule change, access change, deletion, or permission change until the existing approval contract is satisfied." : "Read and prepare autonomously; escalate only if the verified next step becomes externally consequential." };
}

