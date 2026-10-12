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

test("default trigger policy requires end-to-end execution and provider-specific handling", () => {
  assert.match(TRIGGER_DEFAULT_HANDLING, /standing instruction to handle every matching event/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Do not substitute a summary for execution/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /complete routine, in-scope work now/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /verify each provider write with a provider receipt or a read-back/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Email: read the full triggering message and relevant thread/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /send the answer; do not leave a draft solely because the message is personal/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /starts with "Action taken:"/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Slack and other messaging: read the originating conversation and thread/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Ashby applications: inspect the complete application, answers, resume/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Pause only before a refund, deletion, or a critical decision/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Never return NO_ACTION/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /at most six short bullets/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /how completed work was verified/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Do not paste the provider message/i);
});

test("trigger Telegram heading uses Markdown that renders as bold HTML", () => {
  const rendered = mdToTelegramHtml("🔔 **Chusky trigger**\n\nHandled safely.");
  assert.match(rendered, /🔔 <b>Chusky trigger<\/b>/);
  assert.doesNotMatch(rendered, /&lt;b&gt;|<b>Chusky trigger<\/b>.*literal/i);
});

test("trigger closeout preserves a real agent answer", () => {
  assert.deepEqual(ensureTriggerCloseout({
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    summary: "subject: Quick question",
    text: "I replied in the original thread with the confirmed meeting time.",
    toolsUsed: ["GMAIL_SEND_EMAIL"],
    toolsSucceeded: ["GMAIL_SEND_EMAIL"],
  }), { text: "I replied in the original thread with the confirmed meeting time.", reportMissing: false });
});

test("trigger closeout converts NO_ACTION into a delivered honest report without retrying side effects", () => {
  const fallback = ensureTriggerCloseout({
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    summary: "subject: Please confirm tomorrow's time",
    text: "NO_ACTION",
    toolsUsed: ["GMAIL_GET_MESSAGE", "GMAIL_SEND_EMAIL"],
    toolsSucceeded: ["GMAIL_GET_MESSAGE", "GMAIL_SEND_EMAIL"],
  });
  assert.equal(fallback.reportMissing, true);
  assert.match(fallback.text, /did not produce a usable report/i);
  assert.match(fallback.text, /will not replay the event automatically/i);
  assert.match(fallback.text, /connected-app tools were attempted/i);
  assert.doesNotMatch(fallback.text, /GMAIL_SEND_EMAIL/);
  assert.doesNotMatch(fallback.text, /GMAIL_NEW_GMAIL_MESSAGE/);
  assert.match(fallback.text, /Please confirm tomorrow's time/);
});

test("trigger closeout reports an empty, no-tool run without claiming an external action", () => {
  const fallback = ensureTriggerCloseout({ triggerSlug: "SLACK_MESSAGE", summary: "text: Status update", text: "", toolsUsed: [], toolsSucceeded: [] });
  assert.equal(fallback.reportMissing, true);
  assert.match(fallback.text, /No external action was attempted/i);
  assert.match(fallback.text, /Status update/);
});

test("trigger closeouts expose bounded prepared actions without treating them as authorization", () => {
  const parsed = parseTriggerSuggestedActions(`I found a newsletter backlog.\n\n<chusky_actions>[{"label":"Archive","prompt":"Archive the newsletters I described, then verify the inbox."},{"label":"Clear","prompt":"Clear the unread newsletter messages after showing me what will change."}]</chusky_actions>`);
  assert.equal(parsed.text, "I found a newsletter backlog.");
  assert.deepEqual(parsed.actions.map(({ id, label }) => ({ id, label })), [{ id: "action-1", label: "Archive" }, { id: "action-2", label: "Clear" }]);
  const bounded = parseTriggerSuggestedActions(`<chusky_actions>[{"label":"${"x".repeat(100)}","prompt":"${"y".repeat(1000)}"}]</chusky_actions>`);
  assert.equal(bounded.actions[0]?.label.length, 32);
  assert.equal(bounded.actions[0]?.prompt.length, 600);
});
