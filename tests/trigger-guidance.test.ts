import assert from "node:assert/strict";
import test from "node:test";
import { mdToTelegramHtml } from "../src/markdown.js";
import { ensureTriggerCloseout, parseTriggerSuggestedActions, TRIGGER_DEFAULT_HANDLING, triggerWorkflowExhaustion } from "../src/triggerGuidance.js";

test("exhausted trigger workflow preserves a saved outcome without inventing delivery failure", () => {
  assert.deepEqual(triggerWorkflowExhaustion({ status: "running", result: "Replied and verified in the original thread." }), {
    status: "completed",
    result: "Replied and verified in the original thread.",
    notificationStatus: "unknown",
    error: "The trigger work was saved, but a later workflow step did not finish. Check the saved result before retrying any external action.",
  });
});

test("exhausted trigger workflow makes an unsaved run visibly failed without exposing provider errors", () => {
  const failure = triggerWorkflowExhaustion({ status: "running" });
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.notificationStatus, "unknown");
  assert.match(failure?.result ?? "", /could not finish handling this trigger/i);
  assert.doesNotMatch(failure?.result ?? "", /token|password|responsebody/i);
  assert.equal(triggerWorkflowExhaustion({ status: "awaiting_approval" }), undefined);
  assert.equal(triggerWorkflowExhaustion({ status: "completed", result: "Done" }), undefined);
});

test("exhausted notification delivery cannot turn a saved failed trigger into success", () => {
  const failure = triggerWorkflowExhaustion({ status: "failed", result: "The model timed out and the provider outcome is uncertain." });
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.result, "The model timed out and the provider outcome is uncertain.");
  assert.equal(failure?.notificationStatus, "unknown");
  assert.match(failure?.error ?? "", /notification delivery did not finish/i);
});

test("default trigger policy requires end-to-end execution and provider-specific handling", () => {
  assert.match(TRIGGER_DEFAULT_HANDLING, /inspect the source event and relevant record/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /A notification alone is not completion/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /answer an ordinary email in its original thread/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /routine Slack, CRM, scheduling, and other provider events/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /provider receipt or read the changed record/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Identify the source and relevant person or place when available/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /what happened, what you did, and whether the result was verified/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Do not expose event slugs, tool names, internal triage/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /an optional follow-up button is never approval/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Never return NO_ACTION for a verified trigger/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /<example>.*Dana asks a routine question in Gmail/s);
  assert.match(TRIGGER_DEFAULT_HANDLING, /<example>.*Morgan requests a routine correction in Slack #billing/s);
  assert.match(TRIGGER_DEFAULT_HANDLING, /<example>.*A promotional newsletter arrives/s);
  assert.match(TRIGGER_DEFAULT_HANDLING, /<example>.*payment that requires owner approval/s);
});

test("trigger Telegram heading uses Markdown that renders as bold HTML", () => {
  const rendered = mdToTelegramHtml("🔔 **Chusky trigger**\n\nHandled safely.");
  assert.match(rendered, /🔔 <b>Chusky trigger<\/b>/);
  assert.doesNotMatch(rendered, /&lt;b&gt;|<b>Chusky trigger<\/b>.*literal/i);
});

test("trigger closeout preserves a real agent answer", () => {
  assert.deepEqual(ensureTriggerCloseout({
    text: "I replied in the original thread with the confirmed meeting time.",
    toolsUsed: ["GMAIL_SEND_EMAIL"],
  }), { text: "I replied in the original thread with the confirmed meeting time.", reportMissing: false });
});

test("trigger closeout converts NO_ACTION into a delivered honest report without retrying side effects", () => {
  const fallback = ensureTriggerCloseout({
    text: "NO_ACTION",
    toolsUsed: ["GMAIL_GET_MESSAGE", "GMAIL_SEND_EMAIL"],
  });
  assert.equal(fallback.reportMissing, true);
  assert.match(fallback.text, /could not produce a reliable report/i);
  assert.match(fallback.text, /check the connected app before retrying/i);
  assert.doesNotMatch(fallback.text, /GMAIL_SEND_EMAIL/);
  assert.doesNotMatch(fallback.text, /GMAIL_NEW_GMAIL_MESSAGE/);
  assert.doesNotMatch(fallback.text, /Please confirm tomorrow's time/);
});

test("trigger closeout reports an empty, no-tool run without claiming an external action", () => {
  const fallback = ensureTriggerCloseout({ text: "", toolsUsed: [] });
  assert.equal(fallback.reportMissing, true);
  assert.match(fallback.text, /did not attempt an external action/i);
  assert.doesNotMatch(fallback.text, /Status update/);
});

test("trigger closeouts expose bounded prepared actions without treating them as authorization", () => {
  const parsed = parseTriggerSuggestedActions(`I found a newsletter backlog.\n\n<chusky_actions>[{"label":"Archive","prompt":"Archive the newsletters I described, then verify the inbox."},{"label":"Clear","prompt":"Clear the unread newsletter messages after showing me what will change."}]</chusky_actions>`);
  assert.equal(parsed.text, "I found a newsletter backlog.");
  assert.deepEqual(parsed.actions.map(({ id, label }) => ({ id, label })), [{ id: "action-1", label: "Archive" }]);
  const bounded = parseTriggerSuggestedActions(`<chusky_actions>[{"label":"${"x".repeat(100)}","prompt":"${"y".repeat(1000)}"}]</chusky_actions>`);
  assert.equal(bounded.actions[0]?.label.length, 32);
  assert.equal(bounded.actions[0]?.prompt.length, 600);
});
