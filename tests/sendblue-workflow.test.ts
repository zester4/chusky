import test from "node:test";
import assert from "node:assert/strict";
import { processSendblueWorkflow } from "../src/sendblueWorkflow.js";
import type { ChannelInboundEventRecord } from "../src/store.js";

function event(status: ChannelInboundEventRecord["status"] = "queued"): ChannelInboundEventRecord {
  return {
    eventId: "sendblue-event-1", provider: "sendblue", status, createdAt: Date.now(), updatedAt: Date.now(),
    message: { provider: "sendblue", providerEventId: "provider-1", providerUserId: "user-1", providerConversationId: "conversation-1", attachments: [], receivedAt: Date.now(), scope: "private" },
  };
}

test("Sendblue workflow always enters a durable step, including a completed-event replay", async () => {
  let runs = 0;
  let processed = 0;
  const result = await processSendblueWorkflow({ workflowRunId: "wfr-1", run: async (_name, fn) => { runs++; return fn(); } }, "sendblue-event-1", {
    getEvent: async () => event("completed"),
    updateEvent: async () => undefined,
    hydrate: async (message) => message,
    process: async () => { processed++; },
    recordFailure: () => undefined,
  });
  assert.equal(runs, 1);
  assert.equal(processed, 0);
  assert.deepEqual(result, { skipped: true });
});

test("Sendblue workflow performs state transitions within its durable step", async () => {
  const updates: Partial<ChannelInboundEventRecord>[] = [];
  let processed = 0;
  const result = await processSendblueWorkflow({ workflowRunId: "wfr-2", run: async (_name, fn) => fn() }, "sendblue-event-1", {
    getEvent: async () => event(),
    updateEvent: async (_id, patch) => { updates.push(patch); return undefined; },
    hydrate: async (message) => message,
    process: async () => { processed++; },
    recordFailure: () => undefined,
  });
  assert.equal(processed, 1);
  assert.deepEqual(result, { skipped: false });
  assert.deepEqual(updates, [{ status: "running", workflowRunId: "wfr-2" }, { status: "completed" }]);
});

test("Sendblue workflow records a failed durable step and remains retryable", async () => {
  const updates: Partial<ChannelInboundEventRecord>[] = [];
  let failures = 0;
  await assert.rejects(
    () => processSendblueWorkflow({ workflowRunId: "wfr-3", run: async (_name, fn) => fn() }, "sendblue-event-1", {
      getEvent: async () => event(),
      updateEvent: async (_id, patch) => { updates.push(patch); return undefined; },
      hydrate: async () => { throw new Error("temporary media failure"); },
      process: async () => undefined,
      recordFailure: () => { failures++; },
    }),
    /temporary media failure/,
  );
  assert.equal(failures, 1);
  assert.equal(updates[1]?.status, "failed");
});
