import { existsSync, readFileSync } from "node:fs";
import { browserBenchmarkManifest, scoreBrowserBenchmark, type BrowserBenchmarkResult } from "../src/lib/e2b/benchmark.js";

const resultsIndex = process.argv.indexOf("--results");
const resultsPath = resultsIndex >= 0 ? process.argv[resultsIndex + 1] : undefined;
if (!resultsPath || !existsSync(resultsPath)) {
  console.log(JSON.stringify({
    targetPercent: 75,
    message: "Provide --results <json> with explicit evidence statuses; missing evidence is never counted as success.",
    cases: browserBenchmarkManifest(),
  }, null, 2));
  process.exit(resultsPath ? 1 : 0);
}

const parsed: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
if (!Array.isArray(parsed)) throw new Error("Benchmark results must be a JSON array");
const score = scoreBrowserBenchmark(parsed as BrowserBenchmarkResult[]);
console.log(JSON.stringify(score, null, 2));
if (!score.targetMet) process.exitCode = 2;
