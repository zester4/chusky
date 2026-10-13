import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceCallPlan, voiceCallPlanInstructions, voiceToolInterruptionMode } from "../src/calls/voicePlan.js";

const base = {
  id: "twc_00000000-0000-0000-0000-000000000000", userId: 7, provider: "twilio" as const,
  phoneNumber: "+15550001", purpose: "Confirm the appointment and book it if the client chooses a time",
  status: "active" as const, direction: "outbound" as const, callProfile: "business" as const,
  createdAt: 1, updatedAt: 1,
};

test("voice plan separates represented business from the external contact", () => {
  const plan = buildVoiceCallPlan({
    ...base,
    voiceProfile: { identity: "Chusky", organization: "United Cars", mode: "scheduling", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  });
  assert.equal(plan.direction, "outbound");
  assert.equal(plan.representedParty, "United Cars");
  assert.equal(plan.callerFacingTopic, "the appointment");
  assert.deepEqual(plan.capabilityBundles, ["calendar", "crm"]);
  assert.equal(plan.voicemailPolicy, "detect_and_handle");
  assert.match(voiceCallPlanInstructions(plan), /never read this aloud/i);
});

test("voice plan selects bounded business bundles from different objectives", () => {
  const plan = buildVoiceCallPlan({ ...base, purpose: "Follow up on the unpaid invoice, update the customer record, and email the receipt" });
  assert.deepEqual(plan.capabilityBundles, ["crm", "email", "billing"]);
});

test("inbound plan does not inherit outbound voicemail behavior", () => {
  const plan = buildVoiceCallPlan({ ...base, direction: "inbound", purpose: "Check delivery status" });
  assert.equal(plan.direction, "inbound");
  assert.equal(plan.voicemailPolicy, "not_configured");
  assert.deepEqual(plan.capabilityBundles, ["orders"]);
});

test("tool interruption policy keeps reads interruptible and committed writes atomic", () => {
  assert.equal(voiceToolInterruptionMode("GOOGLECALENDAR_FIND_FREE_SLOTS"), "allow");
  assert.equal(voiceToolInterruptionMode("GOOGLECALENDAR_CREATE_EVENT"), "disable_during_tool_and_turn");
  assert.equal(voiceToolInterruptionMode("ZENDESK_UPDATE_ZENDESK_TICKET"), "disable_during_tool_and_turn");
  assert.equal(voiceToolInterruptionMode("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA"), "allow");
});
