/**
 * Read-only storage/API load harness.
 *
 * This is intentionally inert unless STORAGE_LOAD_CONFIRM is set to
 * RUN_READ_ONLY_LOAD. It never POSTs, PATCHes, deletes, creates accounts, or
 * sends provider traffic. For authenticated /v1 routes, provide explicit test
 * owner IDs rather than generating identities against a live account.
 */

import { performance } from "node:perf_hooks";

const baseUrl = (process.env.STORAGE_LOAD_BASE_URL ?? "").trim().replace(/\/+$/, "");
const path = (process.env.STORAGE_LOAD_PATH ?? "/health").trim();
const authToken = (process.env.STORAGE_LOAD_AUTH_TOKEN ?? "").trim();
const ownerIds = (process.env.STORAGE_LOAD_OWNER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const users = Math.max(1, Math.min(1_000, Number(process.env.STORAGE_LOAD_USERS ?? 1_000) || 1_000));
const requestsPerUser = Math.max(1, Math.min(20, Number(process.env.STORAGE_LOAD_REQUESTS_PER_USER ?? 1) || 1));
const concurrency = Math.max(1, Math.min(200, Number(process.env.STORAGE_LOAD_CONCURRENCY ?? 50) || 50));
const timeoutMs = Math.max(1_000, Math.min(60_000, Number(process.env.STORAGE_LOAD_TIMEOUT_MS ?? 20_000) || 20_000));
const confirmation = (process.env.STORAGE_LOAD_CONFIRM ?? "").trim();

type Result = { ok: boolean; status: number; latencyMs: number; bytes: number; error?: string };

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index] ?? 0;
}

function validate(): string | undefined {
  if (!/^https:\/\//i.test(baseUrl)) return "STORAGE_LOAD_BASE_URL must be an HTTPS URL.";
  if (!/^\/(?:[^?]|\?)*$/.test(path) || path.includes("#")) return "STORAGE_LOAD_PATH must be an origin-relative path without a fragment.";
  if (path.startsWith("/v1/") && (!authToken || !ownerIds.length)) return "Authenticated /v1 reads require STORAGE_LOAD_AUTH_TOKEN and explicit STORAGE_LOAD_OWNER_IDS.";
  return undefined;
}

async function request(index: number): Promise<Result> {
  const started = performance.now();
  try {
    const headers: Record<string, string> = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (ownerIds.length) headers["X-Chusky-User-Id"] = ownerIds[index % ownerIds.length]!;
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.arrayBuffer();
    return { ok: response.ok, status: response.status, latencyMs: performance.now() - started, bytes: body.byteLength, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: performance.now() - started, bytes: 0, error: error instanceof Error ? error.message : "request failed" };
  }
}

async function main(): Promise<void> {
  const totalRequests = users * requestsPerUser;
  console.log(JSON.stringify({ mode: confirmation === "RUN_READ_ONLY_LOAD" ? "live-read-only" : "dry-run", baseUrl: baseUrl || "missing", path, users, requestsPerUser, totalRequests, concurrency, ownerIds: ownerIds.length }));
  if (confirmation !== "RUN_READ_ONLY_LOAD") {
    console.log("Dry-run only. Set STORAGE_LOAD_CONFIRM=RUN_READ_ONLY_LOAD after selecting a test environment and explicit test owner IDs.");
    return;
  }
  const validationError = validate();
  if (validationError) throw new Error(validationError);

  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= totalRequests) return;
      results.push(await request(index));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker()));

  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const failures = results.filter((result) => !result.ok);
  const statusCounts: Record<string, number> = {};
  for (const result of results) statusCounts[String(result.status)] = (statusCounts[String(result.status)] ?? 0) + 1;
  console.log(JSON.stringify({
    total: results.length,
    succeeded: results.length - failures.length,
    failed: failures.length,
    statusCounts,
    totalResponseBytes: results.reduce((sum, result) => sum + result.bytes, 0),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: latencies.at(-1) ?? 0 },
    sampleErrors: failures.slice(0, 10).map(({ error, status }) => ({ error, status })),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
