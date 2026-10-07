import assert from "node:assert/strict";
import test from "node:test";
import { backfillDurableSessionSnapshot, repairIncompleteDurableSession } from "../src/durableSessionBackfill.js";
import { DURABLE_SESSION_DOMAINS, type DurableSessionDocument } from "../src/neonDurableState.js";
import { sessionUsesNeonDomains, splitSessionDomains } from "../src/sessionDomains.js";
import type { UserSession } from "../src/store.js";

function session(): UserSession {
  return {
    model: "test/model", totalMessages: 4, totalCost: 0, createdAt: 100, updatedAt: 200,
    history: [{ role: "user", content: "keep this", createdAt: 150 }],
    summaries: ["older context"], memories: [], imageAssets: [], sdkFiles: [], artifacts: [], sdkThreads: [],
    approvals: [{ id: "approval_1", status: "pending", tool: "SAFE_TOOL", arguments: { value: "retain" } }],
  } as unknown as UserSession;
}

function harness(options: { redisChanges?: boolean; initial?: Map<string, DurableSessionDocument> } = {}) {
  const documents = options.initial ?? new Map<string, DurableSessionDocument>();
  const appended: unknown[][] = [];
  let writes = 0;
  let redisValue = "legacy";
  const state = {
    async readSessionDomains() { return new Map(documents) as Map<never, never>; },
    async appendConversationMessages(_userId: number, messages: readonly unknown[]) { appended.push([...messages]); },
    async writeSessionDomains(_userId: number, payloads: ReadonlyMap<string, unknown>, _runs: unknown[], expected: ReadonlyMap<string, number | undefined>) {
      writes += 1;
      assert.equal(expected.size, DURABLE_SESSION_DOMAINS.length);
      for (const [domain, payload] of payloads) documents.set(domain, { domain, payload, version: 1, updatedAt: 1 } as DurableSessionDocument);
      return new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, 1]));
    },
  };
  return {
    state,
    appended,
    get writes() { return writes; },
    get redisValue() { return redisValue; },
    dependencies: {
      state: state as never,
      async compareAndSetRedisSession(_userId: number, _expected: string, replacement: string) {
        if (options.redisChanges) return false;
        redisValue = replacement;
        return true;
      },
    },
  };
}

test("session backfill writes domains then promotes only the exact Redis snapshot", async () => {
  const fixture = harness();
  const raw = JSON.stringify(session());
  const result = await backfillDurableSessionSnapshot(820001, raw, fixture.dependencies);

  assert.equal(result, "migrated");
  assert.equal(fixture.writes, 1);
  assert.equal(fixture.appended.length, 1);
  assert.equal(fixture.appended[0]?.[0] && (fixture.appended[0][0] as { content: string }).content, "keep this");
  const promoted = JSON.parse(fixture.redisValue);
  assert.equal(sessionUsesNeonDomains(promoted as UserSession), true);
  assert.deepEqual(promoted.history.map((message: { content: string }) => message.content), ["keep this"]);
  assert.deepEqual(promoted.summaries, []);
  assert.deepEqual(promoted.approvals, []);
});

test("session backfill leaves Redis untouched when a live save wins the snapshot race", async () => {
  const fixture = harness({ redisChanges: true });
  const result = await backfillDurableSessionSnapshot(820002, JSON.stringify(session()), fixture.dependencies);

  assert.equal(result, "redis_changed");
  assert.equal(fixture.redisValue, "legacy");
  assert.equal(fixture.writes, 1);
});

test("session backfill skips pre-existing divergent or partial Neon domains", async () => {
  const raw = JSON.stringify(session());
  const partial = new Map<string, DurableSessionDocument>([["profile", { domain: "profile", payload: { model: "other/model" }, version: 1, updatedAt: 1 } as DurableSessionDocument]]);
  const fixture = harness({ initial: partial });
  const result = await backfillDurableSessionSnapshot(820003, raw, fixture.dependencies);

  assert.equal(result, "neon_conflict");
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.redisValue, "legacy");
});

test("session backfill repairs missing conversation rows when matching domains survived an interrupted attempt", async () => {
  const snapshot = session();
  const raw = JSON.stringify(snapshot);
  const { domains } = splitSessionDomains({ ...snapshot, history: [{ ...snapshot.history[0], id: "legacy_message" }] } as UserSession);
  const existing = new Map<string, DurableSessionDocument>([...domains].map(([domain, payload]) => [domain, { domain, payload, version: 1, updatedAt: 1 } as DurableSessionDocument]));
  const fixture = harness({ initial: existing });

  const result = await backfillDurableSessionSnapshot(820005, raw, fixture.dependencies);

  assert.equal(result, "migrated");
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.appended.length, 1);
  assert.equal((fixture.appended[0]?.[0] as { content: string }).content, "keep this");
  assert.equal(sessionUsesNeonDomains(JSON.parse(fixture.redisValue) as UserSession), true);
});

test("session backfill rejects owner zero and recognizes an already-promoted snapshot", async () => {
  const fixture = harness();
  await assert.rejects(() => backfillDurableSessionSnapshot(0, JSON.stringify(session()), fixture.dependencies), /positive owner ID/);
  const result = await backfillDurableSessionSnapshot(820004, JSON.stringify({ ...session(), durableSessionFormat: 1 }), fixture.dependencies);
  assert.equal(result, "already_migrated");
  assert.equal(fixture.writes, 0);
});

test("incomplete promoted sessions repair only missing durable domains", async () => {
  const snapshot = session();
  const documents = new Map<string, DurableSessionDocument>([
    ["profile", { domain: "profile", payload: { model: "existing/model" }, version: 7, updatedAt: 1 } as DurableSessionDocument],
  ]);
  const writes: string[] = [];
  const state = {
    async readSessionDomains() { return new Map(documents) as Map<never, never>; },
    async appendConversationMessages(_userId: number, messages: readonly unknown[]) { assert.equal(messages.length, 1); },
    async writeSessionDomains(_userId: number, payloads: ReadonlyMap<string, unknown>, _runs: unknown[], expected: ReadonlyMap<string, number | undefined>) {
      assert.deepEqual([...expected.keys()].sort(), ["assets", "conversation", "memories", "sdk"]);
      for (const [domain, payload] of payloads) {
        writes.push(domain);
        documents.set(domain, { domain, payload, version: 1, updatedAt: 1 } as DurableSessionDocument);
      }
      return new Map([...payloads.keys()].map((domain) => [domain, 1]));
    },
  };

  const repaired = await repairIncompleteDurableSession(820006, snapshot, { state: state as never });

  assert.deepEqual([...repaired.keys()].sort(), ["assets", "conversation", "memories", "profile", "sdk"]);
  assert.deepEqual(writes.sort(), ["assets", "conversation", "memories", "sdk"]);
  assert.deepEqual(repaired.get("profile")?.payload, { model: "existing/model" });
});
