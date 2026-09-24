import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { deliverSdkWebhook, enqueueSdkWebhook, recoverSdkWebhooks } from "../src/lib/webhookOutbox.js";
import { getOutbox, initStore, listOutbox } from "../src/store.js";
import { config } from "../src/config.js";
import { sealWebhookSecret } from "../src/lib/webhooks.js";

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

test("webhook transport uncertainty is quarantined and recovery never blindly replays it", async () => {
  (config as { apiKey: string }).apiKey = "test-server-key";
  const hook = { id: "wh_2", url: "https://hooks.example.test/chusky", secretCiphertext: sealWebhookSecret("whsec_test") };
  const record = await enqueueSdkWebhook(123, hook, "run.completed", { runId: "run_2" });
  let sends = 0;
  const outcome = await deliverSdkWebhook(record, (async () => { sends++; throw new Error("socket closed after receiver accepted body"); }) as typeof fetch);
  assert.equal(outcome.status, "ambiguous");
  assert.match(outcome.lastError ?? "", /verify the receiver before retrying/i);
  assert.equal(sends, 1);
  assert.equal(await recoverSdkWebhooks(), 0);
  assert.equal(sends, 1);
  assert.equal((await getOutbox(record.id))?.status, "ambiguous");
});
