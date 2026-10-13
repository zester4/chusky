import type { BrowserProviderId } from "./types.js";

export type BrowserMetricKind = "attach" | "reconnect" | "action" | "challenge";
export type BrowserMetricStatus = "success" | "failure" | "timeout" | "handoff" | "solved" | "abandoned";

export type BrowserMetricSample = {
  kind: BrowserMetricKind;
  provider: BrowserProviderId;
  status: BrowserMetricStatus;
  durationMs?: number;
  action?: string;
  challengeType?: string;
  ownerId?: number;
};

export type BrowserMetricSummary = {
  count: number;
  failures: number;
  challengeCount: number;
  challengeSolved: number;
  challengeRate: number;
  averageMs?: number;
  p50Ms?: number;
  p95Ms?: number;
};

function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function empty(): BrowserMetricSummary { return { count: 0, failures: 0, challengeCount: 0, challengeSolved: 0, challengeRate: 0 }; }

/** Bounded in-process metrics. Values are aggregates only; no URLs, text, refs, or secrets are retained. */
export class BrowserMetrics {
  private readonly samples: BrowserMetricSample[] = [];
  constructor(private readonly maxSamples = 2_000) {}

  record(sample: BrowserMetricSample): void {
    if (!Number.isFinite(sample.durationMs ?? 0) || (sample.durationMs ?? 0) < 0) return;
    this.samples.push({
      kind: sample.kind,
      provider: sample.provider,
      status: sample.status,
      ...(sample.action ? { action: sample.action.slice(0, 64) } : {}),
      ...(sample.challengeType ? { challengeType: sample.challengeType.slice(0, 64) } : {}),
      ...(sample.durationMs !== undefined ? { durationMs: Math.round(sample.durationMs) } : {}),
    });
    while (this.samples.length > Math.max(100, Math.min(20_000, this.maxSamples))) this.samples.shift();
  }

  measure<T>(sample: Omit<BrowserMetricSample, "durationMs" | "status"> & { successStatus?: BrowserMetricStatus }, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    return operation().then((value) => { this.record({ ...sample, status: sample.successStatus ?? "success", durationMs: Date.now() - startedAt }); return value; }, (error) => { this.record({ ...sample, status: "failure", durationMs: Date.now() - startedAt }); throw error; });
  }

  summary(filter: Partial<Pick<BrowserMetricSample, "kind" | "provider" | "action" | "challengeType">> = {}): BrowserMetricSummary {
    const relevant = this.samples.filter((item) => Object.entries(filter).every(([key, value]) => item[key as keyof BrowserMetricSample] === value));
    const durations = relevant.flatMap((item) => item.durationMs === undefined ? [] : [item.durationMs]);
    const challengeCount = relevant.filter((item) => item.kind === "challenge").length;
    return { count: relevant.length, failures: relevant.filter((item) => ["failure", "timeout", "abandoned"].includes(item.status)).length, challengeCount, challengeSolved: relevant.filter((item) => item.kind === "challenge" && item.status === "solved").length, challengeRate: relevant.length ? challengeCount / relevant.length : 0, ...(durations.length ? { averageMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length), p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) } : {}) };
  }

  snapshot(): Record<string, BrowserMetricSummary> {
    const keys = new Set(this.samples.map((item) => `${item.kind}:${item.provider}`));
    return Object.fromEntries([...keys].sort().map((key) => { const [kind, provider] = key.split(":") as [BrowserMetricKind, BrowserProviderId]; return [key, this.summary({ kind, provider })]; }));
  }

  clear(): void { this.samples.length = 0; }
}

export const browserMetrics = new BrowserMetrics();
export { empty as emptyBrowserMetricSummary };
