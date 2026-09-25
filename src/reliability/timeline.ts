import type { CompensationRecord, OutcomeVerification, ReliabilityTraceEvent } from "./contracts.js";
import type { ExternalActionReceipt, MissionRecord, MissionEventRecord } from "../store.js";

export type OperatorTimelineSource = "mission" | "trace" | "receipt" | "approval" | "verification" | "compensation";

export interface OperatorTimelineItem {
  id: string;
  at: number;
  kind: string;
  type: string;
  status?: string;
  summary: string;
  source: OperatorTimelineSource;
}

interface TimelineApproval { id: string; createdAt: number; status: string; request?: string; missionId?: string; }

/** Merge owner-scoped mission, receipt, verification, compensation, approval, and runtime trace records. */
export function buildOperatorTimeline(input: {
  mission?: MissionRecord;
  missionId?: string;
  trace: ReliabilityTraceEvent[];
  receipts?: ExternalActionReceipt[];
  verifications?: OutcomeVerification[];
  compensations?: CompensationRecord[];
  approvals?: TimelineApproval[];
}): OperatorTimelineItem[] {
  const missionId = input.missionId ?? input.mission?.id;
  const receipts = (input.receipts ?? []).filter((receipt) => !missionId || (receipt.sourceKind === "mission" && receipt.sourceId === missionId));
  const receiptActionIds = new Set(receipts.map((receipt) => receipt.logicalActionId));
  const items: OperatorTimelineItem[] = [];

  if (input.mission && (!missionId || input.mission.id === missionId)) {
    for (const event of input.mission.events ?? []) items.push(missionItem(event));
  }

  for (const event of input.trace) {
    if (missionId && event.correlationId !== missionId && event.parentId !== missionId &&
        !receiptActionIds.has(event.correlationId ?? "") && !receiptActionIds.has(event.parentId ?? "")) continue;
    items.push({
      id: event.id, at: event.at, kind: event.kind, type: event.type, status: event.status,
      summary: event.summary, source: event.kind === "receipt" ? "receipt" : "trace",
    });
  }

  for (const receipt of receipts) items.push(receiptItem(receipt));

  for (const verification of input.verifications ?? []) {
    if (missionId && verification.missionId !== missionId) continue;
    items.push({
      id: verification.id, at: verification.completedAt ?? verification.startedAt,
      kind: "verification", type: "outcome.verification", status: verification.status,
      summary: `Outcome verification ${verification.status}; ${verification.unresolved.length} unresolved check(s).`,
      source: "verification",
    });
  }

  for (const compensation of input.compensations ?? []) {
    if (missionId && compensation.missionId !== missionId) continue;
    items.push({
      id: compensation.id, at: compensation.updatedAt, kind: "compensation",
      type: `compensation.${compensation.status}`, status: compensation.status,
      summary: `Compensation ${compensation.status} for ${safeLabel(compensation.provider, 80)}.`,
      source: "compensation",
    });
  }

  for (const approval of input.approvals ?? []) {
    if (missionId && approval.missionId !== missionId) continue;
    items.push({
      id: approval.id, at: approval.createdAt, kind: "approval", type: "approval",
      status: approval.status, summary: safeLabel(approval.request ?? "Approval requested.", 1000),
      source: "approval",
    });
  }

  return items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-1000);
}

function receiptItem(receipt: ExternalActionReceipt): OperatorTimelineItem {
  return {
    id: receipt.id, at: receipt.updatedAt, kind: "receipt", type: `external_action.${receipt.status}`,
    status: receipt.status,
    summary: `${safeLabel(receipt.tool, 120)} ${receipt.status} through ${receipt.provider}${receipt.receiptVerification ? `; receipt: ${receipt.receiptVerification}` : ""}${receipt.missionEvidenceStatus ? `; mission evidence: ${receipt.missionEvidenceStatus}` : ""}${receipt.missionStepId ? `; step: ${safeLabel(receipt.missionStepId, 120)}` : ""}.`,
    source: "receipt",
  };
}

function safeLabel(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function missionItem(event: MissionEventRecord): OperatorTimelineItem {
  const type = `mission.${event.type}`;
  const status = event.type === "completed" ? "completed" : event.type === "failed" ? "failed" : event.type === "blocked" ? "blocked" : event.type === "waiting" || event.type === "approval_waiting" ? "waiting" : undefined;
  return { id: event.id, at: event.at, kind: event.stepId ? "step" : "mission", type, status, summary: safeLabel(event.message, 1000), source: "mission" };
}
