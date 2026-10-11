import assert from "node:assert/strict";
import test from "node:test";
import { displayTriggerSummary, safeTriggerAgentContext, safeTriggerSummary, triggerRecoveryActions } from "../src/triggerEventSummary.js";

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

test("private agent context retains actionable provider references and application content without credentials", () => {
  const context = safeTriggerAgentContext({
    triggerSlug: "ASHBY_NEW_APPLICATION",
    toolkit: "ashby",
    payload: {
      application: { id: "app_123", candidate: { name: "Taylor Candidate", resume_text: "Built and led a five-person support team." }, job: { title: "Support Lead" } },
      message_id: "msg_456",
      thread_id: "thread_789",
      access_token: "secret-token",
      attachment_data: "base64-secret",
      metadata: { connection_id: "private-connection", trigger_id: "private-trigger", user_id: "user_123" },
    },
  });
  assert.match(context, /application\.id: app_123/);
  assert.match(context, /message_id: msg_456/);
  assert.match(context, /thread_id: thread_789/);
  assert.match(context, /Taylor Candidate/);
  assert.match(context, /Support Lead/);
  assert.doesNotMatch(context, /secret-token|base64-secret|private-connection|private-trigger|user_123/);
  assert.ok(context.length <= 24_000);
});

test("private agent context remains bounded for large provider payloads", () => {
  const payload = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, "x".repeat(4_000)]));
  assert.ok(safeTriggerAgentContext({ triggerSlug: "LARGE_EVENT", payload }).length <= 24_000);
});
