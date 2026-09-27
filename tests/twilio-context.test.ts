import test from "node:test";
import assert from "node:assert/strict";
import { twilioVoiceInstructions } from "../src/calls/twilioContext.js";

const base = {
  id: "twc_00000000-0000-0000-0000-000000000000", userId: 7, provider: "twilio" as const,
  phoneNumber: "+15550001", purpose: "Confirm the implementation meeting", status: "active" as const,
  createdAt: 1, updatedAt: 1,
};

test("outbound Twilio turns receive the owner-authorized objective and private context boundary", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "outbound" });
  assert.match(prompt, /Owner-authorized outbound call objective: Confirm the implementation meeting/);
  assert.match(prompt, /objective as context, not authorization/i);
  assert.match(prompt, /relevant owner-scoped history, memory, knowledge, and connected tools/i);
  assert.match(prompt, /business call, do not volunteer unrelated personal information/i);
  assert.match(prompt, /Deletions, financial actions, permission changes, deployment\/push actions, and provider-declared high-risk actions retain their exact approval boundary/i);
  assert.doesNotMatch(prompt, /never load the owner's full memory/i);
});

test("inbound Twilio turns do not inherit an outbound objective", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.match(prompt, /authorized inbound call/i);
  assert.doesNotMatch(prompt, /Approved outbound call objective/);
});
