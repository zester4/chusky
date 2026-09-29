import assert from "node:assert/strict";
import test from "node:test";
import { ensureTriggerCloseout, TRIGGER_DEFAULT_HANDLING } from "../src/triggerGuidance.js";

test("default trigger policy authorizes clear routine email handling but protects sensitive decisions", () => {
  assert.match(TRIGGER_DEFAULT_HANDLING, /No custom per-trigger instructions are required/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Reply in that same thread when it asks a clear, routine question/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /pricing or financial decisions, legal\/HR\/medical\/security matters/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /create a provider draft when supported, otherwise prepare a concise recommended reply/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /Do not post merely because a channel event fired/i);
  assert.match(TRIGGER_DEFAULT_HANDLING, /always return a useful private owner-facing closeout/i);
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
