import { randomUUID } from "node:crypto";
import { REDIS_METRIC_FAMILIES, RedisCommandMetrics, type RedisCommandMetricsSnapshot, type RedisMetricFamily } from "./redisMetrics.js";
import type { StorageMetricSample, StorageMetricTotals } from "./neonDurableState.js";

export type StorageMetricBatchWriter = (instanceId: string, batchId: number, observedAt: number, samples: readonly StorageMetricSample[]) => Promise<void>;
export type StorageMetricTotalsReader = (sinceMs: number, windowDays: number) => Promise<StorageMetricTotals>;
export type StorageMetricPruner = (beforeMs: number, limit?: number) => Promise<number>;

interface PendingMetricBatch {
  batchId: number;
  observedAt: number;
  samples: StorageMetricSample[];
}

export class RedisMetricsPublisher {
  private nextBatchId = 1;
  private pending?: PendingMetricBatch;
  private inFlight?: Promise<boolean>;
  private lastPruneAt = 0;

  constructor(
    private readonly metrics: RedisCommandMetrics,
    private readonly writeBatch: StorageMetricBatchWriter,
    private readonly options: {
      instanceId?: string;
      now?: () => number;
      readTotals?: StorageMetricTotalsReader;
      prune?: StorageMetricPruner;
      onError?: (error: unknown, phase: "write" | "prune") => void;
    } = {},
  ) {}

  async flush(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.flushInternal();
    try { return await this.inFlight; }
    finally { this.inFlight = undefined; }
  }

  /** Current unflushed command aggregates, including a batch awaiting persistence. */
  unflushedSnapshot(): RedisCommandMetricsSnapshot {
    const current = this.metrics.snapshot();
    if (!this.pending) return current;
    for (const sample of this.pending.samples) {
      const family = current[sample.family];
      family.commands += sample.commands;
      family.errors += sample.errors;
      family.requestBytes += sample.requestBytes;
      family.responseBytes += sample.responseBytes;
      family.durationMs += sample.durationMs;
      family.maxValueBytes = Math.max(family.maxValueBytes, sample.maxValueBytes);
    }
    return current;
  }

  async totals(days = 1): Promise<StorageMetricTotals | undefined> {
    if (!this.options.readTotals) return undefined;
    const now = this.options.now?.() ?? Date.now();
    return this.options.readTotals(now - days * 24 * 60 * 60 * 1000, days);
  }

  private async flushInternal(): Promise<boolean> {
    if (this.pending && !(await this.persistPending())) return false;
    const snapshot = this.metrics.takeSnapshot();
    const samples = REDIS_METRIC_FAMILIES.flatMap((family) => {
      const value = snapshot[family];
      return value.commands || value.errors || value.requestBytes || value.responseBytes || value.durationMs || value.maxValueBytes
        ? [{ family, ...value }]
        : [];
    });
    if (samples.length) {
      this.pending = { batchId: this.nextBatchId, observedAt: this.options.now?.() ?? Date.now(), samples };
      if (!(await this.persistPending())) return false;
    }
    await this.pruneIfDue();
    return true;
  }

  private async persistPending(): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return true;
    try {
      await this.writeBatch(this.options.instanceId ?? (this.options.instanceId = randomUUID()), pending.batchId, pending.observedAt, pending.samples);
      this.pending = undefined;
      this.nextBatchId += 1;
      return true;
    } catch (error) {
      try { this.options.onError?.(error, "write"); } catch { /* Telemetry reporting cannot affect Redis operations. */ }
      return false;
    }
  }

  private async pruneIfDue(): Promise<void> {
    if (!this.options.prune) return;
    const now = this.options.now?.() ?? Date.now();
    if (now - this.lastPruneAt < 24 * 60 * 60 * 1000) return;
    this.lastPruneAt = now;
    try {
      for (let batch = 0; batch < 5; batch += 1) {
        if (await this.options.prune(now - 30 * 24 * 60 * 60 * 1000, 5000) < 5000) break;
      }
    } catch (error) {
      try { this.options.onError?.(error, "prune"); } catch { /* Telemetry reporting cannot affect Redis operations. */ }
    }
  }
}

export function flattenStorageMetricTotals(totals: StorageMetricTotals, prefix: "1d" | "30d"): Record<string, number> {
  return Object.fromEntries(REDIS_METRIC_FAMILIES.flatMap((family: RedisMetricFamily) =>
    Object.entries(totals[family]).map(([metric, value]) => [`redis.persisted.${prefix}.${family}.${metric}`, value]),
  ));
}
