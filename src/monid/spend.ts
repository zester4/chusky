import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { MonidSpendReservation, MonidSpendSnapshot } from "./types.js";

export interface MonidSpendGuardDeps {
  getSnap(userId: number, dayKey: string): Promise<MonidSpendSnapshot | undefined>;
  saveSnap(snapshot: MonidSpendSnapshot): Promise<void>;
  acquireLock?(key: string, token: string, leaseSeconds: number): Promise<boolean>;
  releaseLock?(key: string, token: string): Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

function emptySnapshot(userId: number, dayKey: string): MonidSpendSnapshot {
  return { userId, dayKey, spentUsd: 0, reservedUsd: 0, missionSpent: {}, missionReserved: {}, rateWindowCalls: 0, reservations: {} };
}

function normalized(snapshot: MonidSpendSnapshot): MonidSpendSnapshot {
  return {
    ...snapshot,
    spentUsd: Number.isFinite(snapshot.spentUsd) && snapshot.spentUsd >= 0 ? snapshot.spentUsd : 0,
    reservedUsd: Number.isFinite(snapshot.reservedUsd) && snapshot.reservedUsd >= 0 ? snapshot.reservedUsd : 0,
    missionSpent: snapshot.missionSpent ?? {},
    missionReserved: snapshot.missionReserved ?? {},
    rateWindowCalls: Number.isFinite(snapshot.rateWindowCalls) && snapshot.rateWindowCalls >= 0 ? snapshot.rateWindowCalls : 0,
    reservations: snapshot.reservations ?? {},
  };
}

export class MonidSpendGuard {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: MonidSpendGuardDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private dayKey(date = this.now()): string { return date.toISOString().slice(0, 10); }
  private rateWindowKey(date = this.now()): string { return date.toISOString().slice(0, 16); }

  private async withLock<T>(userId: number, dayKey: string, fn: () => Promise<T>): Promise<T> {
    if (!this.deps.acquireLock || !this.deps.releaseLock) return fn();
    const key = `monid-spend:${userId}:${dayKey}`;
    const token = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      acquired = await this.deps.acquireLock(key, token, 15);
      if (acquired) break;
      await this.sleep(10 + attempt * 10);
    }
    if (!acquired) throw new Error("Monid spend ledger is busy; retry shortly.");
    try { return await fn(); }
    finally { await this.deps.releaseLock(key, token); }
  }

  private validate(userId: number, estimateUsd: number): void {
    if (!config.monidEnabled) throw new Error("Monid is disabled.");
    if (!Number.isSafeInteger(userId) || userId < 0) throw new Error("Invalid Monid owner.");
    if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) throw new Error("Monid spend reservation must be greater than zero.");
    if (estimateUsd > config.monidPerCallSoftCapUsd) throw new Error(`Estimated cost $${estimateUsd.toFixed(4)} exceeds the Monid per-call cap of $${config.monidPerCallSoftCapUsd}.`);
  }

  async reserve(userId: number, estimateUsd: number, missionId?: string): Promise<MonidSpendReservation> {
    this.validate(userId, estimateUsd);
    const dayKey = this.dayKey();
    return this.withLock(userId, dayKey, async () => {
      const snapshot = normalized((await this.deps.getSnap(userId, dayKey)) ?? emptySnapshot(userId, dayKey));
      const rateWindowKey = this.rateWindowKey();
      const calls = snapshot.rateWindowKey === rateWindowKey ? snapshot.rateWindowCalls : 0;
      if (calls >= config.monidRateLimitPerMinute) throw new Error(`Monid rate limit exceeded (${config.monidRateLimitPerMinute} calls per minute).`);
      if (snapshot.spentUsd + snapshot.reservedUsd + estimateUsd > config.monidDailyBudgetUsd) throw new Error(`Monid daily budget exceeded ($${config.monidDailyBudgetUsd}).`);
      if (missionId && (snapshot.missionSpent[missionId] ?? 0) + (snapshot.missionReserved[missionId] ?? 0) + estimateUsd > config.monidMissionBudgetUsd) {
        throw new Error(`Monid mission budget exceeded ($${config.monidMissionBudgetUsd}).`);
      }
      const reservation: MonidSpendReservation = { id: randomUUID(), userId, dayKey, estimateUsd, ...(missionId ? { missionId } : {}), rateWindowKey };
      snapshot.reservedUsd += estimateUsd;
      if (missionId) snapshot.missionReserved[missionId] = (snapshot.missionReserved[missionId] ?? 0) + estimateUsd;
      snapshot.rateWindowKey = rateWindowKey;
      snapshot.rateWindowCalls = calls + 1;
      snapshot.reservations[reservation.id] = { estimateUsd, ...(missionId ? { missionId } : {}) };
      await this.deps.saveSnap(snapshot);
      return reservation;
    });
  }

  /** Returns false when the reservation was already settled. */
  async settle(reservation: MonidSpendReservation, actualCostUsd: number): Promise<boolean> {
    if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) throw new Error("Invalid Monid actual cost.");
    return this.withLock(reservation.userId, reservation.dayKey, async () => {
      const snapshot = normalized((await this.deps.getSnap(reservation.userId, reservation.dayKey)) ?? emptySnapshot(reservation.userId, reservation.dayKey));
      const saved = snapshot.reservations[reservation.id];
      if (!saved) return false;
      snapshot.reservedUsd = Math.max(0, snapshot.reservedUsd - saved.estimateUsd);
      snapshot.spentUsd = Number((snapshot.spentUsd + actualCostUsd).toFixed(6));
      if (saved.missionId) {
        snapshot.missionReserved[saved.missionId] = Math.max(0, (snapshot.missionReserved[saved.missionId] ?? 0) - saved.estimateUsd);
        snapshot.missionSpent[saved.missionId] = Number(((snapshot.missionSpent[saved.missionId] ?? 0) + actualCostUsd).toFixed(6));
      }
      delete snapshot.reservations[reservation.id];
      await this.deps.saveSnap(snapshot);
      return true;
    });
  }
}
