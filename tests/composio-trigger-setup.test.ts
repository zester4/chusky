import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSIO_TRIGGER_EVENT, reconcileComposioTriggerSubscription } from "../src/composioTriggerSetup.js";

test("reconciles a Composio v3.1 subscription to V3 trigger events", async () => {
  let input: unknown;
  const result = await reconcileComposioTriggerSubscription({
    async setWebhookSubscription(value) {
      input = value;
      return { id: "wh_1", webhookUrl: value.webhookUrl, version: "V3", enabledEvents: value.enabledEvents };
    },
  }, "https://chusky.example/composio/triggers");

  assert.deepEqual(input, {
    webhookUrl: "https://chusky.example/composio/triggers",
    enabledEvents: [COMPOSIO_TRIGGER_EVENT],
    version: "V3",
  });
  assert.deepEqual(result, { status: "ready", webhookUrl: "https://chusky.example/composio/triggers", subscriptionId: "wh_1", version: "V3" });
});

test("rejects an insecure Composio trigger URL before changing the subscription", async () => {
  let called = false;
  const result = await reconcileComposioTriggerSubscription({
    async setWebhookSubscription() { called = true; throw new Error("unreachable"); },
  }, "http://localhost:8080/composio/triggers");

  assert.equal(called, false);
  assert.equal(result.status, "misconfigured");
  assert.match(result.error ?? "", /HTTPS/);
});
