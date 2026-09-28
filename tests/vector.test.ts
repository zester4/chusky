import test from "node:test";
import assert from "node:assert/strict";
import { UpstashKnowledgeStore, UpstashVectorRequestError } from "../src/lib/knowledge/vector.js";

const chunk = {
  id: "memory:mem_1:0",
  data: "preference timezone: Europe/London",
  metadata: {
    userId: "7906015891",
    documentId: "mem_1",
    sourceType: "memory",
    chunkIndex: 0,
    visibility: "private" as const,
  },
};

test("retries transient Upstash Vector failures once and returns the provider result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : new Response(JSON.stringify({ result: "Success" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await new UpstashKnowledgeStore("https://vector-retry.test", "token").upsert([chunk]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opens a short outage circuit after bounded retries and avoids repeated provider calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporarily unavailable", { status: 503 });
  };
  try {
    const store = new UpstashKnowledgeStore("https://vector-circuit.test", "token");
    await assert.rejects(() => store.upsert([chunk]), (error: unknown) => {
      assert.ok(error instanceof UpstashVectorRequestError);
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(calls, 2);
    await assert.rejects(() => store.query("7906015891", "timezone"), /temporarily unavailable/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
