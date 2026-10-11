import assert from "node:assert/strict";
import test from "node:test";
import { displayTriggerSummary, safeTriggerSummary, triggerRecoveryActions } from "../src/triggerEventSummary.js";

test("trigger summary turns Gmail payloads into a readable owner-facing preview", () => {
  const summary = safeTriggerSummary({
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    toolkit: "gmail",
    payload: {
      message: { subject: "Renewal question", from: "customer@example.com", body: "Could we discuss renewal dates?" },
      metadata: { api_key: "do-not-show", accessToken: "also-secret" },
      attachmentData: "base64-secret",
    },
  });
  assert.match(summary, /Event: new Gmail message/);
  assert.match(summary, /Subject: Renewal question/);
  assert.match(summary, /From: customer@example.com/);
  assert.match(summary, /Preview: Could we discuss renewal dates/);
  assert.doesNotMatch(summary, /do-not-show|also-secret|base64-secret/);
  assert.doesNotMatch(summary, /Connection:|message_id|accessToken/);
});

test("trigger recovery actions ask the owner to review, not reconnect an already-fired app", () => {
  const actions = triggerRecoveryActions("new Gmail message");
  assert.deepEqual(actions.map((action) => action.label), ["Review", "Open in Chat"]);
  assert.equal(actions.some((action) => /connect/i.test(action.label)), false);
});

test("stored legacy Gmail summaries are re-rendered without raw HTML or internal identifiers", () => {
  const summary = displayTriggerSummary([
    "Trigger: GMAIL_NEW_GMAIL_MESSAGE",
    "Connection: conn_123",
    "inbox_message_id: msg_123",
    "message_text: <html><head><title>Renewal question</title><style>body{display:none}</style></head><body>Could we discuss renewal dates?</body></html>",
  ].join("\n"), "GMAIL_NEW_GMAIL_MESSAGE", "gmail");
  assert.match(summary, /Event: new Gmail message/);
  assert.match(summary, /Subject: Renewal question/);
  assert.match(summary, /Preview: Could we discuss renewal dates/);
  assert.doesNotMatch(summary, /conn_123|msg_123|<html|display:none/);
});

test("trigger summary has strict bounds on depth, field count, and total text size", () => {
  const payload = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, "x".repeat(3_000)]));
  const summary = safeTriggerSummary({ triggerSlug: "TEST", payload });
  assert.ok(summary.length <= 3_500);
  assert.ok((summary.match(/field\d+:/g) ?? []).length <= 40);
});
