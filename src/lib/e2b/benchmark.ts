import { browserBenchmarkCases } from "../../../benchmarks/browser-cases.js";

export type BrowserBenchmarkStatus = "verified" | "failed" | "blocked" | "unverified";

export type BrowserBenchmarkResult = {
  id: string;
  status: BrowserBenchmarkStatus;
  evidence?: string;
};

export type BrowserBenchmarkScore = {
  total: number;
  verified: number;
  failed: number;
  blocked: number;
  unverified: number;
  scorePercent: number;
  targetPercent: number;
  targetMet: boolean;
  byTag: Record<string, { total: number; verified: number; scorePercent: number }>;
};

const TARGET_PERCENT = 75;

function roundedPercent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Scores only explicit evidence. Missing cases remain in the denominator so
 * an incomplete test run cannot accidentally look production-ready.
 */
export function scoreBrowserBenchmark(
  results: readonly BrowserBenchmarkResult[],
  targetPercent = TARGET_PERCENT,
): BrowserBenchmarkScore {
  if (!Number.isFinite(targetPercent) || targetPercent < 0 || targetPercent > 100) {
    throw new Error("targetPercent must be between 0 and 100");
  }

  const knownIds = new Set(browserBenchmarkCases.map((item) => item.id));
  const byId = new Map<string, BrowserBenchmarkResult>();
  for (const result of results) {
    if (!knownIds.has(result.id)) throw new Error(`Unknown browser benchmark case: ${result.id}`);
    if (byId.has(result.id)) throw new Error(`Duplicate browser benchmark result: ${result.id}`);
    if (!["verified", "failed", "blocked", "unverified"].includes(result.status)) {
      throw new Error(`Invalid browser benchmark status for ${result.id}`);
    }
    byId.set(result.id, result);
  }

  const all = browserBenchmarkCases.map((item) => ({
    item,
    status: byId.get(item.id)?.status ?? "unverified" as const,
  }));
  const count = (status: BrowserBenchmarkStatus) => all.filter((entry) => entry.status === status).length;
  const byTag: BrowserBenchmarkScore["byTag"] = {};
  for (const entry of all) {
    for (const tag of entry.item.tags) {
      const current = byTag[tag] ?? { total: 0, verified: 0, scorePercent: 0 };
      current.total += 1;
      if (entry.status === "verified") current.verified += 1;
      current.scorePercent = roundedPercent(current.verified, current.total);
      byTag[tag] = current;
    }
  }

  const total = all.length;
  const verified = count("verified");
  const scorePercent = roundedPercent(verified, total);
  return {
    total,
    verified,
    failed: count("failed"),
    blocked: count("blocked"),
    unverified: count("unverified"),
    scorePercent,
    targetPercent,
    targetMet: scorePercent >= targetPercent,
    byTag,
  };
}

export function browserBenchmarkManifest() {
  return browserBenchmarkCases.map((item) => ({ id: item.id, tags: [...item.tags], goal: item.goal }));
}
