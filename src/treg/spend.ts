import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { TregSpendReservation, TregSpendSnapshot } from "./types.js";

export interface TregSpendGuardDeps {
  getSnap: (userId: number, dayKey: string) => Promise<TregSpendSnapshot | null | undefined>;
  saveSnap: (snap: TregSpendSnapshot) => Promise<void>;
  acquireLock?: (key: string, token: string, leaseSeconds: number) => Promise<boolean>;
  releaseLock?: (key: string, token: string) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const emptySnapshot = (userId: number, dayKey: string): TregSpendSnapshot => ({
  userId,
  dayKey,
  spentUsd: 0,
  reservedUsd: 0,
  missionSpent: {},
  missionReserved: {},
  rateWindowKey: undefined,
  rateWindowCalls: 0,
});

function normalizeSnapshot(snapshot: TregSpendSnapshot): TregSpendSnapshot {
  return {
    ...snapshot,
    spentUsd: Number.isFinite(snapshot.spentUsd) && snapshot.spentUsd >= 0 ? snapshot.spentUsd : 0,
    reservedUsd: Number.isFinite(snapshot.reservedUsd) && snapshot.reservedUsd >= 0 ? snapshot.reservedUsd : 0,
    missionSpent: snapshot.missionSpent ?? {},
    missionReserved: snapshot.missionReserved ?? {},
    rateWindowKey: snapshot.rateWindowKey,
    rateWindowCalls: Number.isFinite(snapshot.rateWindowCalls) && (snapshot.rateWindowCalls ?? 0) >= 0 ? snapshot.rateWindowCalls : 0,
  };
}

export class TregSpendGuard {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TregSpendGuardDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private dayKey(date = this.now()): string {
    return date.toISOString().slice(0, 10);
  }

  private rateWindowKey(date = this.now()): string {
    return date.toISOString().slice(0, 16);
  }

  private lockKey(userId: number, dayKey: string): string {
    return `treg-spend:${userId}:${dayKey}`;
  }

  private async withLock<T>(userId: number, dayKey: string, fn: () => Promise<T>): Promise<T> {
    if (!this.deps.acquireLock || !this.deps.releaseLock) return fn();
    const key = this.lockKey(userId, dayKey);
    const token = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      acquired = await this.deps.acquireLock(key, token, 15);
      if (acquired) break;
      await this.sleep(10 + attempt * 10);
    }
    if (!acquired) throw new Error("Treg spend ledger is busy; retry the request");
    try {
      return await fn();
    } finally {
      await this.deps.releaseLock(key, token);
    }
  }

  private validate(userId: number, estimateUsd: number): void {
    if (!config.tregEnabled) throw new Error("Treg is disabled");
    if (!Number.isSafeInteger(userId) || userId < 0) throw new Error("Invalid Treg user");
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new Error("Invalid Treg cost estimate");
    if (estimateUsd > config.tregPerCallSoftCapUsd) {
      throw new Error(`Estimated cost $${estimateUsd.toFixed(4)} exceeds per-call soft cap $${config.tregPerCallSoftCapUsd}. Request owner approval or lower scope.`);
    }
  }

  async assertCanSpend(userId: number, estimateUsd: number, missionId?: string): Promise<void> {
    this.validate(userId, estimateUsd);
    const dayKey = this.dayKey();
    const snap = normalizeSnapshot((await this.deps.getSnap(userId, dayKey)) ?? emptySnapshot(userId, dayKey));
    const rateWindowKey = this.rateWindowKey();
    const rateWindowCalls = snap.rateWindowKey === rateWindowKey ? snap.rateWindowCalls ?? 0 : 0;
    if (rateWindowCalls >= config.tregRateLimitPerMinute) throw new Error(`Treg rate limit exceeded (${config.tregRateLimitPerMinute} calls per minute).`);
    if (snap.spentUsd + snap.reservedUsd + estimateUsd > config.tregDailyBudgetUsd) {
      throw new Error(`Treg daily budget exceeded ($${config.tregDailyBudgetUsd}).`);
    }
    if (missionId) {
      const spent = snap.missionSpent[missionId] ?? 0;
      const reserved = snap.missionReserved[missionId] ?? 0;
      if (spent + reserved + estimateUsd > config.tregMissionBudgetUsd) {
        throw new Error(`Treg mission budget exceeded ($${config.tregMissionBudgetUsd}).`);
      }
    }
  }

  async reserve(userId: number, estimateUsd: number, missionId?: string): Promise<TregSpendReservation> {
    this.validate(userId, estimateUsd);
    const dayKey = this.dayKey();
    return this.withLock(userId, dayKey, async () => {
      await this.assertCanSpend(userId, estimateUsd, missionId);
      const snap = normalizeSnapshot((await this.deps.getSnap(userId, dayKey)) ?? emptySnapshot(userId, dayKey));
      snap.reservedUsd += estimateUsd;
      if (missionId) snap.missionReserved[missionId] = (snap.missionReserved[missionId] ?? 0) + estimateUsd;
      const rateWindowKey = this.rateWindowKey();
      snap.rateWindowKey = rateWindowKey;
      snap.rateWindowCalls = (snap.rateWindowCalls ?? 0) + 1;
      await this.deps.saveSnap(snap);
      return { id: randomUUID(), userId, dayKey, estimateUsd, missionId, rateWindowKey };
    });
  }

  async settle(reservation: TregSpendReservation, actualCostUsd: number): Promise<void> {
    if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) throw new Error("Invalid Treg actual cost");
    await this.withLock(reservation.userId, reservation.dayKey, async () => {
      const snap = normalizeSnapshot((await this.deps.getSnap(reservation.userId, reservation.dayKey)) ?? emptySnapshot(reservation.userId, reservation.dayKey));
      snap.reservedUsd = Math.max(0, snap.reservedUsd - reservation.estimateUsd);
      snap.spentUsd = Number((snap.spentUsd + actualCostUsd).toFixed(6));
      if (reservation.missionId) {
        const missionReserved = reservation.missionId;
        snap.missionReserved[missionReserved] = Math.max(0, (snap.missionReserved[missionReserved] ?? 0) - reservation.estimateUsd);
        snap.missionSpent[missionReserved] = Number(((snap.missionSpent[missionReserved] ?? 0) + actualCostUsd).toFixed(6));
      }
      await this.deps.saveSnap(snap);
    });
  }

  async recordSpend(userId: number, costUsd: number, missionId?: string): Promise<void> {
    const reservation = await this.reserve(userId, costUsd, missionId);
    await this.settle(reservation, costUsd);
  }
}
