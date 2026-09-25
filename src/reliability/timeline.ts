import type { MissionRecord, MissionEventRecord } from "../store.js";
import type { ReliabilityTraceEvent } from "./contracts.js";

export interface OperatorTimelineItem { id: string; at: number; kind: string; type: string; status?: string; summary: string; source: "mission" | "trace" | "receipt" | "approval"; }

/** Merge mission history and reliability trace into one causal, owner-scoped timeline. */
export function buildOperatorTimeline(input: { mission?: MissionRecord; trace: ReliabilityTraceEvent[]; receipts?: Array<{ id: string; at?: number; status?: string; summary?: string }>; approvals?: Array<{ id: string; createdAt: number; status: string; request?: string }> }): OperatorTimelineItem[] {
  const items: OperatorTimelineItem[] = [];
  if (input.mission) for (const event of input.mission.events ?? []) items.push(missionItem(event));
  for (const event of input.trace) items.push({ id: event.id, at: event.at, kind: event.kind, type: event.type, status: event.status, summary: event.summary, source: event.kind === "receipt" ? "receipt" : "trace" });
  for (const receipt of input.receipts ?? []) items.push({ id: receipt.id, at: receipt.at ?? Date.now(), kind: "receipt", type: "receipt", status: receipt.status, summary: receipt.summary ?? "External receipt recorded.", source: "receipt" });
  for (const approval of input.approvals ?? []) items.push({ id: approval.id, at: approval.createdAt, kind: "approval", type: "approval", status: approval.status, summary: approval.request ?? "Approval requested.", source: "approval" });
  return items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-1000);
}
function missionItem(event: MissionEventRecord): OperatorTimelineItem {
  const type = `mission.${event.type}`;
  const status = event.type === "completed" ? "completed" : event.type === "failed" ? "failed" : event.type === "blocked" ? "blocked" : event.type === "waiting" || event.type === "approval_waiting" ? "waiting" : undefined;
  return { id: event.id, at: event.at, kind: event.stepId ? "step" : "mission", type, status, summary: event.message, source: "mission" };
}
