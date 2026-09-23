import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseTriggerWebhook } from "../src/agent.js";

test("accepts and normalizes a verified Composio V3 trigger payload", async () => {
  const secret = "whsec_test";
  const webhookId = "msg_v3_123";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: webhookId,
    timestamp: "2026-09-10T10:00:00.000Z",
    type: "composio.trigger.message",
    metadata: {
      log_id: "log_123",
      trigger_slug: "GITHUB_COMMIT_EVENT",
      auth_config_id: "ac_123",
      connected_account_id: "ca_123",
      trigger_id: "ti_123",
      user_id: "user_987",
    },
    data: { commit_sha: "abc123", repository: "chusky" },
  });
  const signature = createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${body}`).digest("base64");

  const event = await parseTriggerWebhook(Buffer.from(body), {
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  }, secret);

  assert.deepEqual(event, {
    eventId: webhookId,
    eventType: "composio.trigger.message",
    triggerSlug: "GITHUB_COMMIT_EVENT",
    userId: "user_987",
    triggerId: "ti_123",
    connectionId: "ca_123",
    payload: { commit_sha: "abc123", repository: "chusky" },
    rawPayload: JSON.parse(body),
  });
});

test("accepts signed Composio lifecycle events without a trigger id", async () => {
  const secret = "whsec_test";
  const webhookId = "lifecycle_123";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ id: webhookId, type: "composio.connected_account.expired", metadata: { user_id: "user_988", connected_account_id: "ca_988", toolkit: "gmail" }, data: { reason: "expired" } });
  const signature = createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
  const event = await parseTriggerWebhook(Buffer.from(body), { "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, secret);
  assert.equal(event?.eventType, "composio.connected_account.expired");
  assert.equal(event?.userId, "user_988");
  assert.equal(event?.triggerId, undefined);
  assert.equal(event?.connectionId, "ca_988");
});
