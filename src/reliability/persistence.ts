import { createHash, randomUUID } from "node:crypto";
import { getSession, mutateSession, type UserSession } from "../store.js";
import { assessReliability } from "./evaluator.js";
import type { CompensationRecord, OutcomeVerification, ReliabilityHealth, ReliabilitySample, ReliabilityTraceEvent } from "./contracts.js";

function bounded(value: unknown, max: number): string { return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }

export async function appendReliabilitySample(input: Omit<ReliabilitySample, "id"> & { id?: string }): Promise<ReliabilitySample> {
  const sample: ReliabilitySample = { ...input, id: input.id ? bounded(input.id, 160) : `sample_${randomUUID()}`, operation: bounded(input.operation, 160), provider: input.provider ? bounded(input.provider, 100) : undefined, at: Number.isFinite(input.at) ? input.at : Date.now() };
  await mutateSession(input.ownerId, (session) => {
    session.reliabilitySamples = [...(session.reliabilitySamples ?? []).filter((item) => item.id !== sample.id), sample].slice(-2000);
  });
  return sample;
}

export async function listReliabilitySamples(ownerId: number, operation?: string, limit = 500): Promise<ReliabilitySample[]> {
  const items = (await getSession(ownerId)).reliabilitySamples ?? [];
  return items.filter((item) => !operation || item.operation === operation).slice(-Math.max(1, Math.min(2000, limit)));
}

export async function reliabilityHealth(ownerId: number, operation: string, now = Date.now(), windowMs = 60 * 60_000): Promise<ReliabilityHealth> {
  return assessReliability(await listReliabilitySamples(ownerId, operation, 2000), operation, now, windowMs);
}

export async function saveOutcomeVerification(record: OutcomeVerification): Promise<OutcomeVerification> {
  await mutateSession(record.ownerId, (session) => {
    session.outcomeVerifications = [...(session.outcomeVerifications ?? []).filter((item) => item.id !== record.id && !(record.missionId && item.missionId === record.missionId && item.status === "verified")), record].slice(-200);
  });
  return record;
}

export async function listOutcomeVerifications(ownerId: number, missionId?: string): Promise<OutcomeVerification[]> {
  return ((await getSession(ownerId)).outcomeVerifications ?? []).filter((item) => !missionId || item.missionId === missionId).slice(-200);
}

export async function queueCompensation(input: {
  ownerId: number;
  originalActionId: string;
  provider: string;
  objective: string;
  missionId?: string;
  missionStepId?: string;
  maxAttempts?: number;
}): Promise<CompensationRecord> {
  const idempotencyKey = `comp_${createHash("sha256").update(`${input.ownerId}:${input.originalActionId}:${input.objective}`).digest("hex").slice(0, 48)}`;
  const now = Date.now();
  const record: CompensationRecord = {
    id: `comp_${randomUUID()}`,
    ownerId: input.ownerId,
    ...(input.missionId ? { missionId: bounded(input.missionId, 160) } : {}),
    ...(input.missionStepId ? { missionStepId: bounded(input.missionStepId, 160) } : {}),
    originalActionId: bounded(input.originalActionId, 240),
    provider: bounded(input.provider, 100),
    objective: bounded(input.objective, 4000),
    status: "pending",
    attempts: 0,
    maxAttempts: Math.max(1, Math.min(10, Math.floor(input.maxAttempts ?? 3))),
    idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  return mutateSession(input.ownerId, (session) => {
    const existing = (session.compensations ?? []).find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    session.compensations = [...(session.compensations ?? []), record].slice(-500);
    return record;
  });
}

export async function listCompensations(ownerId: number, statuses?: CompensationRecord["status"][]): Promise<CompensationRecord[]> {
  return ((await getSession(ownerId)).compensations ?? []).filter((item) => !statuses?.length || statuses.includes(item.status)).slice(-500);
}

export async function updateCompensation(ownerId: number, id: string, patch: Partial<CompensationRecord>): Promise<CompensationRecord | undefined> {
  return mutateSession(ownerId, (session) => {
    const current = (session.compensations ?? []).find((item) => item.id === id && item.ownerId === ownerId);
    if (!current) return undefined;
    const next: CompensationRecord = { ...current, ...patch, id: current.id, ownerId, originalActionId: current.originalActionId, updatedAt: Date.now() };
    session.compensations = [...(session.compensations ?? []).filter((item) => item.id !== id), next].slice(-500);
    return next;
  });
}

/** Execute a queued compensation through an injected provider adapter. The adapter must be idempotent. */
export async function executeCompensation(input: {
  ownerId: number;
  id: string;
  approved: boolean;
  execute: (record: CompensationRecord) => Promise<{ summary: string }>;
}): Promise<CompensationRecord | undefined> {
  const record = (await getSession(input.ownerId)).compensations?.find((item) => item.id === input.id && item.ownerId === input.ownerId);
  if (!record) return undefined;
  if (["succeeded", "cancelled"].includes(record.status)) return record;
  if (!input.approved) return updateCompensation(input.ownerId, record.id, { status: "blocked", error: "Owner approval is required before compensation can run." });
  if (record.attempts >= record.maxAttempts) return updateCompensation(input.ownerId, record.id, { status: "blocked", error: "Compensation retry budget exhausted; operator review is required." });
  const running = await updateCompensation(input.ownerId, record.id, { status: "running", attempts: record.attempts + 1, startedAt: Date.now(), error: undefined });
  if (!running) return undefined;
  try {
    const result = await input.execute(running);
    return updateCompensation(input.ownerId, running.id, { status: "succeeded", completedAt: Date.now(), resultSummary: bounded(result.summary, 4000) });
  } catch (error) {
    const message = bounded(error instanceof Error ? error.message : error, 1000);
    return updateCompensation(input.ownerId, running.id, { status: running.attempts >= running.maxAttempts ? "blocked" : "failed", error: message });
  }
}

export async function appendTraceEvent(input: Omit<ReliabilityTraceEvent, "id"> & { id?: string }): Promise<ReliabilityTraceEvent> {
  const event: ReliabilityTraceEvent = { ...input, id: input.id ? bounded(input.id, 160) : `trace_${randomUUID()}`, summary: bounded(input.summary, 2000), type: bounded(input.type, 120), correlationId: input.correlationId ? bounded(input.correlationId, 240) : undefined, parentId: input.parentId ? bounded(input.parentId, 160) : undefined };
  await mutateSession(input.ownerId, (session) => {
    session.reliabilityTrace = [...(session.reliabilityTrace ?? []).filter((item) => item.id !== event.id), event].slice(-5000);
  });
  return event;
}

export async function listTraceEvents(ownerId: number, correlationId?: string, limit = 500): Promise<ReliabilityTraceEvent[]> {
  return ((await getSession(ownerId)).reliabilityTrace ?? []).filter((item) => !correlationId || item.correlationId === correlationId || item.parentId === correlationId).slice(-Math.max(1, Math.min(5000, limit)));
}

export function sessionReliabilityCounts(session: UserSession): { samples: number; verifications: number; compensations: number; traceEvents: number } {
  return { samples: session.reliabilitySamples?.length ?? 0, verifications: session.outcomeVerifications?.length ?? 0, compensations: session.compensations?.length ?? 0, traceEvents: session.reliabilityTrace?.length ?? 0 };
}
