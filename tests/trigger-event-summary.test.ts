import assert from "node:assert/strict";
import test from "node:test";
import { safeTriggerSummary } from "../src/triggerEventSummary.js";

test("trigger summary keeps useful nested message text while redacting credentials and binary payloads", () => {
  const summary = safeTriggerSummary({
    triggerSlug: "GMAIL_NEW_MESSAGE",
    toolkit: "gmail",
    payload: {
      message: { subject: "Renewal question", from: "customer@example.com", body: "Could we discuss renewal dates?" },
      metadata: { api_key: "do-not-show", accessToken: "also-secret" },
      attachmentData: "base64-secret",
    },
  });
  assert.match(summary, /message\.subject: Renewal question/);
  assert.match(summary, /message\.body: Could we discuss renewal dates/);
  assert.doesNotMatch(summary, /do-not-show|also-secret|base64-secret/);
});

test("trigger summary has strict bounds on depth, field count, and total text size", () => {
  const payload = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, "x".repeat(3_000)]));
  const summary = safeTriggerSummary({ triggerSlug: "TEST", payload });
  assert.ok(summary.length <= 3_500);
  assert.ok((summary.match(/field\d+:/g) ?? []).length <= 40);
});
