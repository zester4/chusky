import test from "node:test";
import assert from "node:assert/strict";
import { twilioVoiceInstructions, twilioVoiceOpening, twilioVoiceTranscript } from "../src/calls/twilioContext.js";

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
  assert.match(prompt, /you are the caller because Chusky placed this call on the owner's behalf/i);
  assert.match(prompt, /external contact, client, patient, customer, or recipient/i);
  assert.match(prompt, /never say that you are not calling them/i);
});

test("Twilio opening reflects outbound caller role and objective", () => {
  const opening = twilioVoiceOpening({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Amina", organization: "Chusky Labs", mode: "scheduling", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  });
  assert.equal(opening, "Hello, this is Amina, an AI assistant calling on behalf of Chusky Labs. I’m calling about Confirm the implementation meeting. Is now a good time to speak?");
  assert.doesNotMatch(opening, /How may I help/i);
});

test("business outbound opening remains business-oriented without an organization name", () => {
  const opening = twilioVoiceOpening({ ...base, direction: "outbound", callProfile: "business", purpose: "Follow up on your service request" });
  assert.match(opening, /calling on behalf of the business I represent/i);
  assert.match(opening, /Follow up on your service request/);
});

test("Twilio opening reflects inbound support role", () => {
  const opening = twilioVoiceOpening({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.equal(opening, "Hello, this is Chusky, an AI assistant. How may I help you today?");
});

test("Twilio transcript identifies the external speaker separately from owner history", () => {
  assert.equal(
    twilioVoiceTranscript({ ...base, direction: "outbound" }, "Why are you calling me?"),
    "The external contact answering the outbound call said: Why are you calling me?",
  );
});

test("inbound Twilio turns do not inherit an outbound objective", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.match(prompt, /authorized inbound call/i);
  assert.doesNotMatch(prompt, /Approved outbound call objective/);
});
