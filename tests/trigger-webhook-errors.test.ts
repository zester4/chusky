import test from "node:test";
import assert from "node:assert/strict";
import { DurableSessionDocumentsIncompleteError } from "../src/sessionDomains.js";
import { classifyTriggerWebhookSessionFailure } from "../src/triggerWebhookErrors.js";

test("incomplete durable sessions make trigger delivery retryable", () => {
  const failure = classifyTriggerWebhookSessionFailure(new DurableSessionDocumentsIncompleteError(["conversation", "memories"]));
  assert.deepEqual(failure, {
    status: 503,
    retryAfterSeconds: 30,
    body: { ok: false, error: "temporary session storage unavailable", retryable: true },
  });
});

test("ordinary trigger failures are not reclassified as session outages", () => {
  assert.equal(classifyTriggerWebhookSessionFailure(new Error("provider rejected webhook")), undefined);
});
