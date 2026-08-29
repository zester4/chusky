import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { enqueueSdkWebhook } from "../src/lib/webhookOutbox.js";
import { getOutbox, initStore } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("SDK webhook notifications are durable and idempotently queued", async () => {
  const hook = { id: "wh_1", url: "https://hooks.example.test/chusky", secretCiphertext: "encrypted" };
  const first = await enqueueSdkWebhook(123, hook, "run.completed", { runId: "run_1", status: "completed" });
  const second = await enqueueSdkWebhook(123, hook, "run.completed", { runId: "run_1", status: "completed" });
  assert.equal(second.id, first.id);
  const persisted = await getOutbox(first.id);
  assert.equal(persisted?.status, "queued");
  assert.equal(persisted?.provider, "webhook");
  assert.deepEqual(persisted?.webhook?.payload, { type: "run.completed", data: { runId: "run_1", status: "completed" } });
});
