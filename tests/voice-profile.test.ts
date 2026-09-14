import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVoiceCallProfile, voiceProfileInstructions, voiceProfileNativeTools } from "../src/calls/voiceProfile.js";
import { initStore, getPhoneCall } from "../src/store.js";
import { startTwilioCallForUser } from "../src/calls/twilio.js";

test("voice profiles force spoken-language instructions and only expose selected read-only capabilities", () => {
  const profile = normalizeVoiceCallProfile({
    identity: "Amina", organization: "Chusky Labs", mode: "sales", tone: "consultative",
    opening: "Hello, this is Amina from Chusky Labs.",
    facts: ["The customer requested a product demonstration."],
    guardrails: ["Do not pressure the caller."], capabilities: ["schedule_lookup", "task_lookup"],
  });
  const prompt = voiceProfileInstructions(profile, "outbound", "Qualify the product demonstration request");
  assert.match(prompt, /natural plain speech only/i);
  assert.match(prompt, /Never use Markdown, emojis, brackets/i);
  assert.match(prompt, /Amina, speaking on behalf of Chusky Labs/);
  assert.match(prompt, /Conversation mode: sales/);
  assert.deepEqual(voiceProfileNativeTools(profile), ["CHUCK_LIST_REMINDERS", "CHUCK_LIST_JOBS", "CHUCK_TASK_LIST", "CHUCK_TASK_GET"]);
});

test("profile normalization strips control characters, bounds facts, and ignores invented capabilities", () => {
  const profile = normalizeVoiceCallProfile({
    identity: "Chusky\u0000", facts: ["One", "One", 42, "Two"], capabilities: ["memory_lookup", "delete_everything"],
  });
  assert.equal(profile.identity, "Chusky");
  assert.equal(profile.mode, "general");
  assert.deepEqual(profile.facts, ["One", "Two"]);
  assert.deepEqual(profile.capabilities, ["memory_lookup"]);
});

test("Twilio persists the approved normalized profile with the call", async () => {
  await initStore({ memoryOnly: true });
  const call = await startTwilioCallForUser(502, {
    phoneNumber: "+15550001", purpose: "Schedule a demonstration",
    profile: { identity: "Maya", tone: "warm", capabilities: ["scratchpad_lookup"] },
  }, {
    enabled: true, accountSid: "AC123", authToken: "auth", callerId: "+16452437121",
    webhookBaseUrl: "https://chusky.example", mediaStreamUrl: "wss://voice.example/twilio/stream",
    createCall: async () => ({ sid: "CAprofile" }),
  });
  assert.deepEqual((await getPhoneCall(502, call.id))?.voiceProfile, {
    identity: "Maya", mode: "general", tone: "warm", facts: [], guardrails: [], capabilities: ["scratchpad_lookup"],
  });
});
