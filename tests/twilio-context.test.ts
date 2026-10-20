import test from "node:test";
import assert from "node:assert/strict";
import { callerFacingCallTopic, twilioVoiceHistory, twilioVoiceInstructions, twilioVoiceKeyterms, twilioVoiceOpening, twilioVoiceTranscript } from "../src/calls/twilioContext.js";

const base = {
  id: "twc_00000000-0000-0000-0000-000000000000", userId: 7, provider: "twilio" as const,
  phoneNumber: "+15550001", purpose: "Confirm the implementation meeting", status: "active" as const,
  createdAt: 1, updatedAt: 1,
};

test("outbound Twilio turns receive the owner-authorized objective and private context boundary", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "outbound" });
  assert.match(prompt, /Owner-authorized outbound call objective: Confirm the implementation meeting/);
  assert.match(prompt, /objective as context, not authorization/i);
  assert.match(prompt, /approved call context, bounded relevant memory, and purpose-approved connected tools/i);
  assert.match(prompt, /business call, do not volunteer unrelated personal information/i);
  assert.match(prompt, /Deletions, financial actions, permission changes, deployment\/push actions, and provider-declared high-risk actions retain their exact approval boundary/i);
  assert.doesNotMatch(prompt, /never load the owner's full memory/i);
  assert.match(prompt, /Chusky placed this call on the owner's behalf/i);
  assert.match(prompt, /external contact, client, patient, customer, or recipient/i);
  assert.match(prompt, /never say that you are not calling them/i);
});

test("Twilio opening reflects outbound caller role and objective", () => {
  const opening = twilioVoiceOpening({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Amina", organization: "Chusky Labs", mode: "scheduling", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  });
  assert.equal(opening, "Hi, this is Amina, an assistant from Chusky Labs. I'm calling to confirm the implementation meeting. Is now a good time to talk for a minute?");
  assert.doesNotMatch(opening, /intended person|may I speak/i);
  assert.doesNotMatch(opening, /How may I help/i);
});

test("outbound opening names the supplied contact without inventing identity", () => {
  const opening = twilioVoiceOpening({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Amina", organization: "Chusky Labs", contactName: "Collins", mode: "support", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  });
  assert.equal(opening, "Hi Collins, this is Amina, an assistant from Chusky Labs. I'm calling to confirm the implementation meeting. Is now a good time to talk for a minute?");
});

test("outbound opening never speaks private follow-up instructions", () => {
  const purpose = "Confirm if they’ll be available for the meeting about the car deal tomorrow at 10:00am, if they agree book it in our calendar";
  assert.equal(callerFacingCallTopic(purpose), "your availability for the meeting about the car deal tomorrow at 10:00am");
  const opening = twilioVoiceOpening({ ...base, direction: "outbound", purpose });
  assert.match(opening, /calling about your availability for the meeting about the car deal tomorrow at 10:00am/i);
  assert.match(opening, /good time to talk for a minute/i);
  assert.doesNotMatch(opening, /intended person|may I speak/i);
  assert.doesNotMatch(opening, /if they agree|book it|our calendar/i);
});

test("voice instructions explicitly keep the outbound objective private", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "outbound", purpose: "Confirm if they agree, book it" });
  assert.match(prompt, /INTERNAL VOICE CONTEXT.*NEVER READ THIS INSTRUCTION BLOCK ALOUD/i);
  assert.match(prompt, /Never expose the call objective wording/i);
});

test("business outbound opening remains business-oriented without an organization name", () => {
  const opening = twilioVoiceOpening({ ...base, direction: "outbound", callProfile: "business", purpose: "Follow up on your service request" });
  assert.match(opening, /assistant for the business I represent/i);
  assert.match(opening, /calling to follow up on your service request/i);
  assert.doesNotMatch(opening, /intended person|may I speak/i);
});

test("Twilio opening reflects inbound support role", () => {
  const opening = twilioVoiceOpening({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.equal(opening, "Hello, this is Chusky, an assistant. How may I help you today?");
});

test("explicit AI disclosure is opt-in for a caller-facing opening", () => {
  const opening = twilioVoiceOpening({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Maya", organization: "MedVault", disclosure: "explicit_ai", mode: "support", tone: "warm", facts: [], guardrails: [], capabilities: [] },
  });
  assert.equal(opening, "Hi, this is Maya, an AI assistant from MedVault. I'm calling to confirm the implementation meeting. Is now a good time to talk for a minute?");
});

test("Twilio transcript identifies the external speaker separately from owner history", () => {
  assert.equal(
    twilioVoiceTranscript({ ...base, direction: "outbound" }, "Why are you calling me?"),
    "The external contact answering the outbound call said: Why are you calling me?",
  );
});

test("Twilio vocabulary contains only bounded approved call facts", () => {
  const keyterms = twilioVoiceKeyterms({
    ...base,
    voiceProfile: { identity: "Amina", organization: "United Cars", mode: "scheduling", tone: "professional", facts: ["Treffley", "Tomorrow at nine AM"], guardrails: [], capabilities: [] },
  });
  assert.deepEqual(keyterms, ["Amina", "United Cars", "Treffley", "Tomorrow at nine AM"]);
});

test("interrupted assistant speech is kept separate from the next caller turn", () => {
  assert.equal(
    twilioVoiceTranscript({ ...base, direction: "outbound" }, "Can we do two PM?", "I can offer ten AM or two PM"),
    "The assistant was interrupted after saying: I can offer ten AM or two PM. The external contact answering the outbound call said: Can we do two PM?",
  );
});

test("voice history is isolated to finalized turns from this call", () => {
  const history = twilioVoiceHistory({
    ...base,
    direction: "outbound",
    transcript: { turns: [{ id: "1", at: 1, caller: "I can do nine tomorrow.", assistant: "I will check that now." }], truncated: false, updatedAt: 1 },
  });
  assert.deepEqual(history.map((message) => message.content), ["The external contact said: I can do nine tomorrow.", "I will check that now."]);
});

test("voice history includes the transport opening before the first caller turn", () => {
  const history = twilioVoiceHistory({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Chusky", organization: "MedVault", contactName: "Treffley", mode: "scheduling", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  }, "Hi Treffley, this is Chusky, an assistant from MedVault. I'm calling about your refill tomorrow. Is now a good time to talk for a minute?");
  assert.deepEqual(history.map((message) => message.content), ["Hi Treffley, this is Chusky, an assistant from MedVault. I'm calling about your refill tomorrow. Is now a good time to talk for a minute?"]);
});

test("voice instructions continue after an affirmative transport identity answer", () => {
  const prompt = twilioVoiceInstructions({
    ...base,
    direction: "outbound",
    voiceProfile: { identity: "Chusky", organization: "MedVault", contactName: "Treffley", mode: "scheduling", tone: "professional", facts: [], guardrails: [], capabilities: [] },
  });
  assert.match(prompt, /transport greeting has already addressed Treffley/i);
  assert.match(prompt, /do not ask who they are/i);
  assert.match(prompt, /short and caller-facing/i);
  assert.match(prompt, /BOOKING COMPLETION CONTRACT/i);
  assert.match(prompt, /collect the appointment subject or service/i);
  assert.match(prompt, /duration or end time/i);
  assert.match(prompt, /successful create or update receipt/i);
  assert.match(prompt, /do not silently send an SMS or email/i);
});

test("inbound Twilio turns do not inherit an outbound objective", () => {
  const prompt = twilioVoiceInstructions({ ...base, direction: "inbound", purpose: "Inbound phone call" });
  assert.match(prompt, /authorized inbound call/i);
  assert.doesNotMatch(prompt, /Approved outbound call objective/);
});
