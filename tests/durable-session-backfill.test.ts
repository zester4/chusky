import assert from "node:assert/strict";
import test from "node:test";
import { backfillDurableSessionSnapshot } from "../src/durableSessionBackfill.js";
import { DURABLE_SESSION_DOMAINS, type DurableSessionDocument } from "../src/neonDurableState.js";
import { sessionUsesNeonDomains } from "../src/sessionDomains.js";
import type { UserSession } from "../src/store.js";

function session(): UserSession {
  return {
    model: "test/model", totalMessages: 4, totalCost: 0, createdAt: 100, updatedAt: 200,
    history: [{ role: "user", content: "keep this", createdAt: 150 }],
    summaries: ["older context"], memories: [], imageAssets: [], sdkFiles: [], artifacts: [], sdkThreads: [],
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

test("session backfill rejects owner zero and recognizes an already-promoted snapshot", async () => {
  const fixture = harness();
  await assert.rejects(() => backfillDurableSessionSnapshot(0, JSON.stringify(session()), fixture.dependencies), /positive owner ID/);
  const result = await backfillDurableSessionSnapshot(820004, JSON.stringify({ ...session(), durableSessionFormat: 1 }), fixture.dependencies);
  assert.equal(result, "already_migrated");
  assert.equal(fixture.writes, 0);
});
