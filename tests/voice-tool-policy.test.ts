import test from "node:test";
import assert from "node:assert/strict";
import {
  bindVoicePolicyAccount,
  normalizeVoiceToolPolicy,
  voicePolicyAllowsExecution,
  voiceToolkitAllowed,
} from "../src/calls/voiceToolPolicy.js";

test("voice tool policy filters exact Composio actions by selected toolkit", () => {
  const policy = normalizeVoiceToolPolicy({ enabled: true, allowedToolkits: ["Google Calendar"], allowExternalWrites: true });
  assert.equal(voiceToolkitAllowed("GOOGLECALENDAR_CREATE_EVENT", policy), true);
  assert.equal(voiceToolkitAllowed("STRIPE_CREATE_REFUND", policy), false);
  assert.equal(voicePolicyAllowsExecution("GOOGLECALENDAR_CREATE_EVENT", {}, policy), true);
  assert.equal(voicePolicyAllowsExecution("STRIPE_CREATE_REFUND", {}, policy), false);
});

test("voice tool policy pins the only selected account and rejects account switching", () => {
  const policy = normalizeVoiceToolPolicy({ enabled: true, allowedToolkits: ["gmail"], allowedConnectionIds: ["conn_primary"], allowExternalWrites: true });
  const bound = bindVoicePolicyAccount({}, policy, [{ id: "conn_primary", alias: "work inbox" }]);
  assert.equal(bound.account, "conn_primary");
  assert.equal(voicePolicyAllowsExecution("GMAIL_SEND_EMAIL", { account: "conn_primary" }, policy, [{ id: "conn_primary" }]), true);
  assert.equal(voicePolicyAllowsExecution("GMAIL_SEND_EMAIL", { account: "conn_other" }, policy, [{ id: "conn_primary" }]), false);
  const accountOnly = normalizeVoiceToolPolicy({ allowedConnectionIds: ["conn_primary"] });
  assert.equal(voicePolicyAllowsExecution("GMAIL_SEND_EMAIL", { account: "conn_other" }, accountOnly, [{ id: "conn_primary" }]), false);
});

test("voice tool policy blocks external writes when the call is read-only", () => {
  const policy = normalizeVoiceToolPolicy({ enabled: true, allowedToolkits: ["stripe"], allowExternalWrites: false });
  assert.equal(voicePolicyAllowsExecution("STRIPE_LIST_CUSTOMERS", {}, policy), true);
  assert.equal(voicePolicyAllowsExecution("STRIPE_CREATE_REFUND", {}, policy), false);
  assert.equal(voicePolicyAllowsExecution("COMPOSIO_SEARCH_TOOLS", { query: "Find refund tools" }, policy), true);
  assert.equal(voicePolicyAllowsExecution("COMPOSIO_SEARCH_TOOLS", {}, normalizeVoiceToolPolicy({ enabled: false })), false);
  assert.equal(voicePolicyAllowsExecution("COMPOSIO_EXECUTE_TOOL", { tool_slug: "STRIPE_CREATE_REFUND", arguments: {} }, policy), false);
});

