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
    return { rows: [] as never[] };
  }
  release() { this.released = true; }
}

class FakePool {
  readonly client = new FakeClient();
  reads: unknown[] = [];
  ended = false;
  async query(_text: string, _values?: unknown[]) { return { rows: this.reads as never[] }; }
  async connect() { return this.client; }
  async end() { this.ended = true; }
}

function session(): UserSession {
  const now = Date.now();
  return {
    model: "test/model", history: [{ role: "user", content: "hello" }], totalMessages: 1, totalCost: 0,
    triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [{ id: "mem_1", category: "fact", key: "k", value: "v", confidence: 1, source: "test", sensitivity: "sensitive", status: "active", createdAt: now, updatedAt: now }],
    imageAssets: [{ id: "img_1", name: "image", r2Key: "owner/image", contentType: "image/png", sizeBytes: 1, createdAt: now, updatedAt: now }], summaries: ["summary"], approvals: [], sdkThreads: [{ id: "thr_1", externalId: "external", metadata: {}, history: [], runs: [], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now,
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

test("session split leaves no high-growth payload in the Redis core and restores it exactly", () => {
  const original = session();
  const { core, domains } = splitSessionDomains(original);
  assert.equal((core as UserSession & { durableSessionFormat?: number }).durableSessionFormat, DURABLE_SESSION_FORMAT);
  assert.deepEqual(core.history, []);
  assert.deepEqual(core.memories, []);
  assert.deepEqual(core.imageAssets, []);
  assert.deepEqual(core.sdkThreads, []);
  assert.deepEqual(joinSessionDomains(core, domains).history, original.history);
  assert.deepEqual(joinSessionDomains(core, domains).memories, original.memories);
  assert.deepEqual(joinSessionDomains(core, domains).sdkThreads, original.sdkThreads);
  assert.throws(() => joinSessionDomains(core, new Map()), /incomplete/);
});
