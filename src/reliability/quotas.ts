import { randomUUID } from "node:crypto";
import { getSession, mutateSession } from "../store.js";
import type { QuotaDecision } from "./contracts.js";

export interface QuotaLimits { maxCallsPerDay?: number; maxCostUsdPerDay?: number; maxConcurrent?: number; }

export interface QuotaReservationDecision extends QuotaDecision { reservationId?: string; }

function limitsOf(limits: QuotaLimits) {
  return {
    maxCalls: Math.max(1, Math.floor(limits.maxCallsPerDay ?? 1000)),
    maxCost: Math.max(0, limits.maxCostUsdPerDay ?? 100),
    maxConcurrent: Math.max(1, Math.floor(limits.maxConcurrent ?? 4)),
  };
}

function snapshot(session: Awaited<ReturnType<typeof getSession>>, operation: string, now: number) {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  const samples = (session.reliabilitySamples ?? []).filter((item) => item.operation === operation && item.at >= dayStart);
  const reservations = (session.executionReservations ?? []).filter((item) => item.operation === operation && item.expiresAt > now);
  const toolCalls = samples.length;
  const cost = samples.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  // Queued SDK runs have not acquired an execution slot yet; durable workers
  // account for them through executionReservations when they actually start.
  const running = operation === "sdk.run"
    ? (session.sdkThreads?.reduce((sum, thread) => sum + thread.runs.filter((run) => run.status === "running").length, 0) ?? 0)
    : 0;
  return { toolCalls, admittedCalls: toolCalls + reservations.length, cost, concurrent: running + reservations.length, reservations };
}

/** Durable, owner-scoped quota decision used before starting an external run. */
export async function checkExecutionQuota(ownerId: number, operation: string, limits: QuotaLimits = {}, now = Date.now()): Promise<QuotaDecision> {
  const session = await getSession(ownerId);
  const { admittedCalls, cost, concurrent } = snapshot(session, operation, now);
  const { maxCalls, maxCost, maxConcurrent } = limitsOf(limits);
  const remaining = { toolCalls: Math.max(0, maxCalls - admittedCalls), costUsd: Math.max(0, maxCost - cost), concurrent: Math.max(0, maxConcurrent - concurrent) };
  if (admittedCalls >= maxCalls) return { allowed: false, reason: "Daily execution quota reached.", remaining };
  if (cost >= maxCost) return { allowed: false, reason: "Daily cost quota reached.", remaining };
  if (concurrent >= maxConcurrent) return { allowed: false, reason: "Concurrent execution quota reached.", remaining };
  return { allowed: true, remaining };
}

/**
 * Atomically admit a run. A read-only quota check is insufficient for queued
 * work because two workers can pass it before either one records a sample.
 */
export async function reserveExecutionQuota(ownerId: number, operation: string, limits: QuotaLimits = {}, reservationId = `quota_${randomUUID()}`, now = Date.now(), ttlMs = 30 * 60_000): Promise<QuotaReservationDecision> {
  return mutateSession(ownerId, (session) => {
    const { maxCalls, maxCost, maxConcurrent } = limitsOf(limits);
    const current = snapshot(session, operation, now);
    const existing = current.reservations.find((item) => item.id === reservationId);
    if (existing) return { allowed: true, reservationId, remaining: { toolCalls: Math.max(0, maxCalls - current.admittedCalls), costUsd: Math.max(0, maxCost - current.cost), concurrent: Math.max(0, maxConcurrent - current.concurrent) } };
    const remaining = { toolCalls: Math.max(0, maxCalls - current.admittedCalls), costUsd: Math.max(0, maxCost - current.cost), concurrent: Math.max(0, maxConcurrent - current.concurrent) };
    if (current.admittedCalls >= maxCalls) return { allowed: false, reason: "Daily execution quota reached.", remaining };
    if (current.cost >= maxCost) return { allowed: false, reason: "Daily cost quota reached.", remaining };
    if (current.concurrent >= maxConcurrent) return { allowed: false, reason: "Concurrent execution quota reached.", remaining };
    const boundedTtl = Math.max(60_000, Math.min(ttlMs, 24 * 60 * 60_000));
    session.executionReservations = [...current.reservations, { id: reservationId, operation: operation.slice(0, 100), createdAt: now, expiresAt: now + boundedTtl }].slice(-100);
    return { allowed: true, reservationId, remaining: { toolCalls: Math.max(0, remaining.toolCalls - 1), costUsd: remaining.costUsd, concurrent: Math.max(0, remaining.concurrent - 1) } };
  });
}

export async function releaseExecutionQuota(ownerId: number, reservationId: string): Promise<void> {
  await mutateSession(ownerId, (session) => {
    session.executionReservations = (session.executionReservations ?? []).filter((item) => item.id !== reservationId);
  });
}
