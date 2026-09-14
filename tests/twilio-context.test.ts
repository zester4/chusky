import test from "node:test";
import assert from "node:assert/strict";
import { twilioVoiceInstructions } from "../src/calls/twilioContext.js";

const base = {
  id: "twc_00000000-0000-0000-0000-000000000000", userId: 7, provider: "twilio" as const,
  phoneNumber: "+15550001", purpose: "Confirm the implementation meeting", status: "active" as const,
  createdAt: 1, updatedAt: 1,
};

test("outbound Twilio turns receive the approved objective but retain the action boundary", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "outbound" });
  assert.match(prompt, /Approved outbound call objective: Confirm the implementation meeting/);
  assert.match(prompt, /not as authorization/i);
  assert.match(prompt, /continue in Telegram for approvals or actions/i);
});

test("inbound Twilio turns do not inherit an outbound objective", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.match(prompt, /authorized inbound call/i);
  assert.doesNotMatch(prompt, /Approved outbound call objective/);
});
