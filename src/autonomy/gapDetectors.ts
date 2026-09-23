/**
 * Deterministic business-signal detectors. Provider adapters may supply
 * normalized records from any connected app; values are treated as evidence,
 * never as instructions. The detector only proposes work and never sends,
 * spends, deletes, or changes permissions.
 */

export type BusinessGapType =
  | "overdue_invoice"
  | "unreplied_message"
  | "stale_lead"
  | "staffing_coverage"
  | "stalled_onboarding"
  | "missed_follow_up";

export interface GapEvidence {
  source: string;
  recordId?: string;
  summary: string;
}

export interface BusinessGap {
  key: string;
  type: BusinessGapType;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  reason: string;
  recommendedNextAction: string;
  requiresApproval: boolean;
  evidence: GapEvidence[];
  detectedAt: number;
}

export interface NormalizedBusinessSignal {
  id?: string;
  source: string;
  kind: string;
  subject?: string;
  status?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  dueAt?: string | number;
  lastActivityAt?: string | number;
  repliedAt?: string | number;
  assignedTo?: string;
  expectedCount?: number;
  actualCount?: number;
  amount?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface GapDetectorOptions {
  now?: number;
  invoiceOverdueMs?: number;
  messageUnrepliedMs?: number;
  leadStaleMs?: number;
  onboardingStaleMs?: number;
}

const day = 24 * 60 * 60 * 1000;

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function text(value: unknown, max = 180): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function evidence(signal: NormalizedBusinessSignal, summary: string): GapEvidence {
  return { source: text(signal.source, 120) || "connected_app", ...(signal.id ? { recordId: text(signal.id, 180) } : {}), summary: text(summary, 400) };
}

function key(type: BusinessGapType, signal: NormalizedBusinessSignal): string {
  return `${type}:${text(signal.source, 80)}:${text(signal.id || signal.subject || signal.kind, 160)}`.toLowerCase();
}

function status(value: unknown): string { return text(value, 80).toLowerCase().replace(/[\s-]+/g, "_"); }

export function detectBusinessGaps(signals: readonly NormalizedBusinessSignal[], options: GapDetectorOptions = {}): BusinessGap[] {
  const now = options.now ?? Date.now();
  const invoiceAge = options.invoiceOverdueMs ?? 3 * day;
  const messageAge = options.messageUnrepliedMs ?? 2 * day;
  const leadAge = options.leadStaleMs ?? 7 * day;
  const onboardingAge = options.onboardingStaleMs ?? 2 * day;
  const gaps: BusinessGap[] = [];
  for (const signal of signals.slice(0, 500)) {
    const kind = status(signal.kind);
    const state = status(signal.status);
    const due = timestamp(signal.dueAt);
    const updated = timestamp(signal.updatedAt ?? signal.lastActivityAt ?? signal.createdAt);
    const subject = text(signal.subject || signal.id || signal.kind, 180) || "Unlabelled record";
    if ((kind === "invoice" || kind === "payment_invoice" || kind === "bill") && due !== undefined && due < now - invoiceAge && !["paid", "void", "cancelled", "canceled", "settled"].includes(state)) {
      const amount = signal.amount !== undefined ? ` ${signal.currency ? `${text(signal.currency, 8)} ` : ""}${signal.amount}` : "";
      gaps.push({ key: key("overdue_invoice", signal), type: "overdue_invoice", severity: due < now - 30 * day ? "critical" : due < now - 7 * day ? "high" : "medium", title: `Overdue invoice: ${subject}`, reason: `Invoice is past due${amount}.`, recommendedNextAction: "Verify payment status, prepare a compliant reminder, and request approval before sending or changing payment state.", requiresApproval: true, evidence: [evidence(signal, `dueAt=${new Date(due).toISOString()}; status=${state || "unknown"}`)], detectedAt: now });
      continue;
    }
    if ((kind === "message" || kind === "email" || kind === "conversation" || kind === "ticket") && !signal.repliedAt && updated !== undefined && updated < now - messageAge && !["closed", "resolved", "archived", "spam"].includes(state)) {
      gaps.push({ key: key("unreplied_message", signal), type: "unreplied_message", severity: updated < now - 7 * day ? "high" : "medium", title: `Unreplied message: ${subject}`, reason: `No reply is recorded after ${Math.round((now - updated) / day)} day(s).`, recommendedNextAction: "Read the thread, classify urgency and intent, draft a response, and ask for approval before sending unless a standing order explicitly allows it.", requiresApproval: true, evidence: [evidence(signal, `lastActivityAt=${new Date(updated).toISOString()}; status=${state || "open"}`)], detectedAt: now });
      continue;
    }
    if ((kind === "lead" || kind === "deal" || kind === "opportunity") && updated !== undefined && updated < now - leadAge && !["won", "lost", "closed", "disqualified"].includes(state)) {
      gaps.push({ key: key("stale_lead", signal), type: "stale_lead", severity: updated < now - 30 * day ? "high" : "medium", title: `Stale opportunity: ${subject}`, reason: `No meaningful activity is recorded after ${Math.round((now - updated) / day)} day(s).`, recommendedNextAction: "Review recent context, identify the next legitimate step, and prepare a follow-up or owner decision.", requiresApproval: true, evidence: [evidence(signal, `lastActivityAt=${new Date(updated).toISOString()}; assignedTo=${text(signal.assignedTo, 100) || "unassigned"}`)], detectedAt: now });
      continue;
    }
    if ((kind === "staffing" || kind === "shift" || kind === "coverage" || kind === "schedule") && signal.expectedCount !== undefined && signal.actualCount !== undefined && signal.actualCount < signal.expectedCount) {
      gaps.push({ key: key("staffing_coverage", signal), type: "staffing_coverage", severity: signal.actualCount === 0 ? "critical" : "high", title: `Coverage gap: ${subject}`, reason: `${signal.expectedCount - signal.actualCount} required coverage slot(s) are unfilled.`, recommendedNextAction: "Identify the affected window and prepare an owner-approved coverage request; never contact staff or alter schedules without authorization.", requiresApproval: true, evidence: [evidence(signal, `expected=${signal.expectedCount}; actual=${signal.actualCount}`)], detectedAt: now });
      continue;
    }
    if ((kind === "onboarding" || kind === "implementation" || kind === "activation") && updated !== undefined && updated < now - onboardingAge && !["complete", "completed", "active", "cancelled", "canceled"].includes(state)) {
      gaps.push({ key: key("stalled_onboarding", signal), type: "stalled_onboarding", severity: "high", title: `Stalled onboarding: ${subject}`, reason: `The onboarding record has not progressed after ${Math.round((now - updated) / day)} day(s).`, recommendedNextAction: "Locate the blocked checklist item, prepare a recovery plan, and assign the next owner.", requiresApproval: false, evidence: [evidence(signal, `lastActivityAt=${new Date(updated).toISOString()}; status=${state || "unknown"}`)], detectedAt: now });
      continue;
    }
    if ((kind === "meeting" || kind === "call" || kind === "follow_up") && updated !== undefined && updated < now - messageAge && !["complete", "completed", "closed", "cancelled", "canceled"].includes(state)) {
      gaps.push({ key: key("missed_follow_up", signal), type: "missed_follow_up", severity: "medium", title: `Missed follow-up: ${subject}`, reason: "A meeting or call has no recorded completion or follow-up.", recommendedNextAction: "Review the outcome and prepare the agreed next step, with approval for external communication.", requiresApproval: true, evidence: [evidence(signal, `lastActivityAt=${new Date(updated).toISOString()}; status=${state || "unknown"}`)], detectedAt: now });
    }
  }
  const seen = new Set<string>();
  return gaps.filter((gap) => !seen.has(gap.key) && (seen.add(gap.key), true)).slice(0, 100);
}

