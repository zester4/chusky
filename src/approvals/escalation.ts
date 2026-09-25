import { randomUUID } from "node:crypto";
import { getSession, saveSession } from "../store.js";
import { appendReliabilitySample, appendTraceEvent } from "../reliability/persistence.js";

export type ApprovalEscalationStatus = "pending" | "escalated" | "acknowledged" | "closed" | "failed";
export interface ApprovalEscalationRecord {
  id: string;
  ownerId: number;
  approvalId: string;
  destination: "jira" | "channel";
  summary: string;
  /** Exact owner-selected connected-app action used for the escalation. */
  toolSlug?: string;
  /** Bounded provider arguments; never accepts credential-shaped fields. */
  toolArgs?: Record<string, unknown>;
  dueAt: number;
  status: ApprovalEscalationStatus;
  attempts: number;
  externalIssueKey?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

function clean(value: unknown, max: number): string { return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }

function safeToolArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const blocked = /token|secret|password|credential|cookie|authorization|private.?key/i;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !blocked.test(key)).slice(0, 40);
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key)) continue;
    if (typeof item === "string") normalized[key] = item.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 4000);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) normalized[key] = item;
    else if (Array.isArray(item)) normalized[key] = item.slice(0, 20).map((entry) => typeof entry === "string" ? entry.slice(0, 400) : typeof entry === "number" || typeof entry === "boolean" || entry === null ? entry : "[object]");
    else normalized[key] = "[object]";
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export async function scheduleApprovalEscalation(input: { ownerId: number; approvalId: string; destination?: "jira" | "channel"; summary: string; dueAt: number; toolSlug?: string; toolArgs?: Record<string, unknown> }): Promise<ApprovalEscalationRecord> {
  const session = await getSession(input.ownerId);
  const existing = session.approvalEscalations?.find((item) => item.approvalId === input.approvalId && ["pending", "escalated"].includes(item.status));
  if (existing) return existing;
  const now = Date.now();
  const normalizedToolSlug = input.toolSlug ? clean(input.toolSlug, 160) : undefined;
  const record: ApprovalEscalationRecord = { id: `esc_${randomUUID()}`, ownerId: input.ownerId, approvalId: clean(input.approvalId, 160), destination: input.destination ?? "jira", summary: clean(input.summary, 2000), dueAt: Number.isFinite(input.dueAt) ? input.dueAt : now, status: "pending", attempts: 0, createdAt: now, updatedAt: now, ...(normalizedToolSlug ? { toolSlug: normalizedToolSlug } : {}), ...(safeToolArgs(input.toolArgs) ? { toolArgs: safeToolArgs(input.toolArgs) } : {}) };
  session.approvalEscalations = [...(session.approvalEscalations ?? []), record].slice(-500);
  await saveSession(input.ownerId, session);
  await appendTraceEvent({ ownerId: input.ownerId, kind: "approval", type: "approval.escalation_scheduled", at: now, correlationId: record.id, status: record.status, summary: `Approval escalation scheduled for ${record.destination}.` }).catch(() => undefined);
  return record;
}

export async function listApprovalEscalations(ownerId: number, statuses?: ApprovalEscalationStatus[]): Promise<ApprovalEscalationRecord[]> {
  return ((await getSession(ownerId)).approvalEscalations ?? []).filter((item) => item.ownerId === ownerId && (!statuses?.length || statuses.includes(item.status))).slice(-500);
}

export async function claimDueApprovalEscalation(ownerId: number, id: string, now = Date.now()): Promise<ApprovalEscalationRecord | undefined> {
  const session = await getSession(ownerId);
  const current = session.approvalEscalations?.find((item) => item.id === id && item.ownerId === ownerId);
  if (!current || current.status !== "pending" || current.dueAt > now) return undefined;
  const next = { ...current, status: "escalated" as const, attempts: current.attempts + 1, updatedAt: now };
  session.approvalEscalations = [...(session.approvalEscalations ?? []).filter((item) => item.id !== id), next];
  await saveSession(ownerId, session);
  return next;
}

export async function updateApprovalEscalation(ownerId: number, id: string, patch: Partial<ApprovalEscalationRecord>): Promise<ApprovalEscalationRecord | undefined> {
  const session = await getSession(ownerId); const current = session.approvalEscalations?.find((item) => item.id === id && item.ownerId === ownerId); if (!current) return undefined;
  const next = { ...current, ...patch, id: current.id, ownerId, updatedAt: Date.now() };
  session.approvalEscalations = [...(session.approvalEscalations ?? []).filter((item) => item.id !== id), next]; await saveSession(ownerId, session); return next;
}

export interface ApprovalEscalationAdapter {
  create: (record: ApprovalEscalationRecord) => Promise<{ externalIssueKey?: string; summary?: string }>;
}

/** Claim and deliver due escalations exactly once per attempt. Provider writes stay behind this adapter. */
export async function runDueApprovalEscalations(ownerId: number, adapter?: ApprovalEscalationAdapter, now = Date.now()): Promise<ApprovalEscalationRecord[]> {
  const due = (await listApprovalEscalations(ownerId, ["pending"])) .filter((item) => item.dueAt <= now).slice(0, 20);
  const results: ApprovalEscalationRecord[] = [];
  for (const item of due) {
    const claimed = await claimDueApprovalEscalation(ownerId, item.id, now);
    if (!claimed) continue;
    if (!adapter) {
      const failed = await updateApprovalEscalation(ownerId, claimed.id, { status: "failed", error: "No escalation provider adapter is configured; no external issue or message was created." }) ?? claimed;
      await appendReliabilitySample({ ownerId, operation: "approval_escalation", status: "failure", at: now }).catch(() => undefined);
      await appendTraceEvent({ ownerId, kind: "approval", type: "approval.escalation_failed", at: now, correlationId: claimed.id, status: failed.status, summary: "Approval escalation could not run because no provider adapter was configured." }).catch(() => undefined);
      results.push(failed);
      continue;
    }
    try {
      const result = await adapter.create(claimed);
      const escalated = await updateApprovalEscalation(ownerId, claimed.id, { status: "escalated", externalIssueKey: result.externalIssueKey, error: undefined, summary: result.summary ? clean(result.summary, 2000) : claimed.summary }) ?? claimed;
      await appendReliabilitySample({ ownerId, operation: "approval_escalation", status: "success", at: now }).catch(() => undefined);
      await appendTraceEvent({ ownerId, kind: "approval", type: "approval.escalation_succeeded", at: now, correlationId: claimed.id, status: escalated.status, summary: "Approval escalation provider action completed." }).catch(() => undefined);
      results.push(escalated);
    } catch (error) {
      const failed = await updateApprovalEscalation(ownerId, claimed.id, { status: claimed.attempts >= 3 ? "failed" : "pending", error: clean(error instanceof Error ? error.message : error, 1000) }) ?? claimed;
      await appendReliabilitySample({ ownerId, operation: "approval_escalation", status: failed.status === "pending" ? "uncertain" : "failure", at: now }).catch(() => undefined);
      await appendTraceEvent({ ownerId, kind: "approval", type: "approval.escalation_failed", at: now, correlationId: claimed.id, status: failed.status, summary: "Approval escalation provider action failed or is retryable." }).catch(() => undefined);
      results.push(failed);
    }
  }
  return results;
}
