import assert from "node:assert/strict";
import test from "node:test";
import { DURABLE_SESSION_DOMAINS, NeonDurableState } from "../src/neonDurableState.js";
import { DURABLE_SESSION_FORMAT, joinSessionDomains, splitSessionDomains } from "../src/sessionDomains.js";
import type { UserSession } from "../src/store.js";

class FakeClient {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  failOnInsert = false;
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failOnInsert && text.includes("INSERT INTO chusky_session_domain")) throw new Error("database unavailable");
    return { rows: text.includes("INSERT INTO chusky_sdk_run") ? [{ run_id: "run_1" }] as never[] : [] as never[] };
  }
  release() { this.released = true; }
}

class FakePool {
  readonly client = new FakeClient();
  reads: unknown[] = [];
  calls: Array<{ text: string; values?: unknown[] }> = [];
  failRead = false;
  ended = false;
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failRead) throw new Error("database unavailable");
    return { rows: this.reads as never[] };
  }
  async connect() { return this.client; }
  async end() { this.ended = true; }
}

function session(): UserSession {
  const now = Date.now();
  return {
    model: "test/model", history: [{ role: "user", content: "hello" }], totalMessages: 1, totalCost: 0,
    triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [{ id: "mem_1", category: "fact", key: "k", value: "v", confidence: 1, source: "test", sensitivity: "sensitive", status: "active", createdAt: now, updatedAt: now }],
    imageAssets: [{ id: "img_1", name: "image", r2Key: "owner/image", contentType: "image/png", sizeBytes: 1, createdAt: now, updatedAt: now }], summaries: ["summary"], approvals: [], sdkThreads: [{ id: "thr_1", externalId: "external", metadata: {}, history: [], runs: [{ id: "run_1", status: "completed", input: "private", output: "result", events: [], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now,
  };
}

test("Neon durable session domains write atomically and reject partial writes", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, { domain }] as const));
  await state.writeSessionDomains(42, documents);
  assert.equal(pool.client.calls[0]?.text, "BEGIN");
  assert.equal(pool.client.calls.filter((call) => call.text.includes("INSERT INTO chusky_session_domain")).length, 4);
  assert.equal(pool.client.calls.at(-1)?.text, "COMMIT");
  assert.equal(pool.client.released, true);
  await assert.rejects(() => state.writeSessionDomains(42, new Map([["conversation", {}]] as const)), /every session domain/);
});

test("Neon durable session-domain failures roll back and release the connection", async () => {
  const pool = new FakePool();
  pool.client.failOnInsert = true;
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, { domain }] as const));
  await assert.rejects(() => state.writeSessionDomains(42, documents), /database unavailable/);
  assert.ok(pool.client.calls.some((call) => call.text === "ROLLBACK"));
  assert.equal(pool.client.released, true);
});

test("Neon session writes extract SDK runs into rows in the same transaction", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, domain === "sdk" ? { sdkThreads: [{ id: "thr_1", runs: [] }] } : { domain }] as const));
  const run = { id: "run_1", status: "completed", input: "private", output: "result", events: [], createdAt: 1_000, updatedAt: 1_000 };
  await state.writeSessionDomains(42, documents, [{ threadId: "thr_1", runId: "run_1", payload: run }]);
  const calls = pool.client.calls;
  const sdkRunInsert = calls.findIndex((call) => call.text.includes("INSERT INTO chusky_sdk_run"));
  assert.ok(sdkRunInsert > 0);
  assert.ok(sdkRunInsert < calls.findIndex((call) => call.text === "COMMIT"));
  assert.deepEqual(calls[sdkRunInsert]?.values, [42, "thr_1", "run_1", JSON.stringify(run), 1_000, 1_000]);
});

test("Neon health verifies reachability with a lightweight query", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const health = await state.healthStatus();
  assert.deepEqual(pool.reads, []);
  assert.equal(health.reachable, true);
  assert.deepEqual(health, { enabled: true, reachable: true });
});

test("Neon health reports unavailable state without leaking database errors", async () => {
  const pool = new FakePool();
  pool.failRead = true;
  const state = new NeonDurableState(pool as never);
  const health = await state.healthStatus();
  assert.equal(health.reachable, false);
  assert.deepEqual(health, { enabled: true, reachable: false });
});

test("Neon SDK run reads are owner- and thread-scoped and listing is bounded", async () => {
  const pool = new FakePool();
  const at = new Date("2026-10-03T00:00:00.000Z");
  pool.reads = [{ user_id: "42", thread_id: "thr_test", run_id: "run_test", payload: { id: "run_test", status: "completed", events: [] }, created_at: at, updated_at: at }];
  const state = new NeonDurableState(pool as never);

  const run = await state.readSdkRun(42, "thr_test", "run_test");
  assert.equal(run?.userId, 42);
  assert.equal(run?.payload && (run.payload as { id: string }).id, "run_test");
  assert.deepEqual(pool.calls[0]?.values, [42, "thr_test", "run_test"]);

  const listed = await state.listSdkRuns(42, "thr_test", 50_000);
  assert.equal(listed.length, 1);
  assert.match(pool.calls[1]?.text ?? "", /ORDER BY created_at ASC, run_id ASC LIMIT \$3/);
  assert.deepEqual(pool.calls[1]?.values, [42, "thr_test", 200]);
  pool.reads = [];
  assert.equal(await state.readSdkRun(42, "thr_test", "run_other"), undefined);
  assert.deepEqual(pool.calls[2]?.values, [42, "thr_test", "run_other"]);
  await assert.rejects(() => state.listSdkRuns(42, "bad", 50), /identity is invalid/);
});

test("Neon SDK run writes validate identities and upsert a single run row", async () => {
  const pool = new FakePool();
  pool.reads = [{ run_id: "run_test" }];
  const state = new NeonDurableState(pool as never);
  const run = { id: "run_test", status: "running", events: [], createdAt: 1000, updatedAt: 1000 };
  await state.writeSdkRun(42, "thr_test", "run_test", run);
  const write = pool.calls[0]!;
  assert.match(write.text, /INSERT INTO chusky_sdk_run/);
  assert.match(write.text, /ON CONFLICT \(user_id, run_id\) DO UPDATE/);
  assert.match(write.text, /WHERE chusky_sdk_run.thread_id = EXCLUDED.thread_id/);
  assert.deepEqual(write.values, [42, "thr_test", "run_test", JSON.stringify(run), 1000, 1000]);
  pool.reads = [];
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_test", run), /identity conflicts/);
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_other", run), /payload is invalid/);
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_test", { ...run, updatedAt: 999 }), /timestamps are invalid/);
});

test("Neon SDK run records continue to support legacy CLI thread IDs", async () => {
  const pool = new FakePool();
  const at = new Date("2026-10-03T00:00:00.000Z");
  pool.reads = [{ user_id: "42", thread_id: "cli_thread_legacy", run_id: "run_cli_test", payload: { id: "run_cli_test", status: "queued", events: [] }, created_at: at, updated_at: at }];
  const state = new NeonDurableState(pool as never);
  const run = { id: "run_cli_test", status: "queued", events: [], createdAt: 1000, updatedAt: 1000 };
  await state.writeSdkRun(42, "cli_thread_legacy", "run_cli_test", run);
  assert.equal(pool.calls[0]?.values?.[1], "cli_thread_legacy");
  assert.equal((await state.listSdkRuns(42, "cli_thread_legacy"))[0]?.runId, "run_cli_test");
  assert.deepEqual(pool.calls[1]?.values, [42, "cli_thread_legacy", 100]);
});

test("Neon SDK run deletion is constrained to the owner and thread", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.deleteSdkRunsForThread(42, "thr_test");
  assert.match(pool.calls[0]?.text ?? "", /DELETE FROM chusky_sdk_run WHERE user_id = \$1 AND thread_id = \$2/);
  assert.deepEqual(pool.calls[0]?.values, [42, "thr_test"]);
});

test("session split leaves runs out of the SDK document and emits owner-thread run records", () => {
  const original = session();
  const { core, domains, sdkRuns } = splitSessionDomains(original, true);
  assert.equal((core as UserSession & { durableSessionFormat?: number }).durableSessionFormat, DURABLE_SESSION_FORMAT);
  assert.deepEqual(core.history, []);
  assert.deepEqual(core.memories, []);
  assert.deepEqual(core.imageAssets, []);
  assert.deepEqual(core.sdkThreads, []);
  assert.deepEqual(joinSessionDomains(core, domains).history, original.history);
  assert.deepEqual(joinSessionDomains(core, domains).memories, original.memories);
  assert.deepEqual((domains.get("sdk") as { sdkThreads: Array<{ runs: unknown[] }> }).sdkThreads[0]?.runs, []);
  assert.deepEqual(sdkRuns, [{ threadId: "thr_1", run: original.sdkThreads![0]!.runs[0] }]);
  assert.deepEqual(joinSessionDomains(core, domains).sdkThreads?.[0]?.runs, []);
  assert.throws(() => joinSessionDomains(core, new Map()), /incomplete/);
});

test("session-domain writes retain embedded SDK runs until per-run cutover is enabled", () => {
  const original = session();
  const { domains, sdkRuns } = splitSessionDomains(original);
  assert.deepEqual(sdkRuns, []);
  assert.deepEqual((domains.get("sdk") as { sdkThreads: Array<{ runs: unknown[] }> }).sdkThreads[0]?.runs, original.sdkThreads![0]!.runs);
});
