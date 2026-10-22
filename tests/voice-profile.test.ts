import test from "node:test";
import assert from "node:assert/strict";
import { defaultBusinessVoiceProfile, normalizeBusinessVoiceCallProfile, normalizeVoiceCallProfile, resolveOutboundVoiceCallProfile, voiceProfileInstructions, voiceProfileNativeTools } from "../src/calls/voiceProfile.js";
import { initStore, getPhoneCall, getVoiceCallProfile, setVoiceCallProfile } from "../src/store.js";
import { startTwilioCallForUser } from "../src/calls/twilio.js";

test("voice profiles keep spoken output while private owner calls use full context and tools", () => {
  const profile = normalizeVoiceCallProfile({
    identity: "Amina", organization: "Chusky Labs", mode: "sales", tone: "consultative",
    opening: "Hello, this is Amina from Chusky Labs.",
    facts: ["The customer requested a product demonstration."],
    guardrails: ["Do not pressure the caller."], capabilities: ["schedule_lookup", "task_lookup"],
  });
  const prompt = voiceProfileInstructions(profile, "outbound", "Qualify the product demonstration request");
  assert.match(prompt, /natural plain speech only/i);
  assert.match(prompt, /Never use Markdown, emojis, brackets/i);
  assert.match(prompt, /VOICE-FIRST OUTPUT/i);
  assert.match(prompt, /Good voice example/i);
  assert.match(prompt, /Bad voice example/i);
  assert.match(prompt, /OUTBOUND OPENING/i);
  assert.match(prompt, /configured disclosure policy/i);
  assert.match(prompt, /Never claim to be human, a nurse, doctor, lawyer, accountant/i);
  assert.match(prompt, /Ask one question at a time/i);
  assert.match(prompt, /OUTBOUND FLOW/i);
  assert.match(prompt, /Amina, speaking on behalf of Chusky Labs/);
  assert.match(prompt, /Conversation mode: sales/);
  assert.match(prompt, /relevant private context and connected tools/i);
  assert.match(prompt, /Deletions, financial actions, permission changes, deployment\/push actions, and provider-declared high-risk actions retain their exact approval boundary/i);
  assert.match(prompt, /business call, do not volunteer or disclose the owner's unrelated personal/i);
  assert.doesNotMatch(prompt, /Use only this call brief|Do not claim to perform an external action/i);
  assert.deepEqual(voiceProfileNativeTools(profile), ["CHUCK_LIST_REMINDERS", "CHUCK_LIST_JOBS", "CHUCK_TASK_LIST", "CHUCK_TASK_GET"]);
  assert.doesNotMatch(voiceProfileInstructions(profile, "inbound", "Answer the caller's question"), /OUTBOUND OPENING|OUTBOUND FLOW/i);
});

test("profile normalization strips control characters, bounds facts, and ignores invented capabilities", () => {
  const profile = normalizeVoiceCallProfile({
    identity: "Chusky\u0000", facts: ["One", "One", 42, "Two"], capabilities: ["memory_lookup", "delete_everything"],
  });
  assert.equal(profile.identity, "Chusky");
  assert.equal(profile.disclosure, "assistant");
  assert.equal(profile.mode, "general");
  assert.deepEqual(profile.facts, ["One", "Two"]);
  assert.deepEqual(profile.capabilities, ["memory_lookup"]);
});

test("voice identity cannot turn a configured assistant into a regulated professional", () => {
  const profile = normalizeVoiceCallProfile({ identity: "Dr. Amina, licensed nurse" });
  assert.equal(profile.identity, "Chusky");
  assert.match(voiceProfileInstructions(profile, "outbound", "Check in"), /Never claim to be human, a nurse, doctor, lawyer, accountant/i);
});

test("business calls receive a capable default representative when none is configured", () => {
  const profile = defaultBusinessVoiceProfile();
  assert.equal(profile.identity, "Chusky");
  assert.equal(profile.mode, "support");
  assert.equal(profile.toolPolicy?.enabled, true);
  assert.deepEqual(profile.toolPolicy?.allowedToolkits, []);
  assert.match(voiceProfileInstructions(profile, "inbound", "Handle the caller's request"), /UNAVAILABLE CAPABILITY AND ESCALATION/);
  assert.match(voiceProfileInstructions(profile, "inbound", "Handle the caller's request"), /preferred follow-up method/i);

  const partial = normalizeBusinessVoiceCallProfile({ identity: "Alex", organization: "Acme" });
  assert.equal(partial.identity, "Alex");
  assert.equal(partial.organization, "Acme");
  assert.equal(partial.toolPolicy?.enabled, true);
  assert.match(partial.guardrails.join(" "), /connected business records/i);
});

test("explicit AI disclosure is opt-in and remains a one-time introduction", () => {
  const profile = normalizeVoiceCallProfile({ identity: "Maya", organization: "MedVault", disclosure: "explicit_ai" });
  const prompt = voiceProfileInstructions(profile, "outbound", "Check in with the patient");
  assert.equal(profile.disclosure, "explicit_ai");
  assert.match(prompt, /briefly identify yourself as an AI assistant once/i);
  assert.match(prompt, /Do not repeat that label/i);
});

test("Twilio persists the approved normalized profile with the call", async () => {
  await initStore({ memoryOnly: true });
  const call = await startTwilioCallForUser(502, {
    phoneNumber: "+15550001", purpose: "Schedule a demonstration",
    profile: { identity: "Maya", tone: "warm", capabilities: ["scratchpad_lookup"] },
  }, {
    enabled: true, accountSid: "AC123", authToken: "auth", callerId: "+16452437121",
    webhookBaseUrl: "https://chusky.example", mediaStreamUrl: "wss://voice.example/twilio/stream", mediaBridgeSecret: "bridge-secret",
    createCall: async () => ({ sid: "CAprofile" }),
  });
  assert.deepEqual((await getPhoneCall(502, call.id))?.voiceProfile, {
    identity: "Maya", mode: "general", tone: "warm", facts: [], guardrails: [], capabilities: ["scratchpad_lookup"], disclosure: "assistant",
  });
});

test("outbound calls use the saved Calls representative as the authoritative profile", async () => {
  await initStore({ memoryOnly: true });
  await setVoiceCallProfile(504, {
    identity: "Maya",
    organization: "MedVault",
    mode: "support",
    tone: "warm",
    guardrails: ["Record the caller's report exactly."],
    capabilities: ["call_history"],
    toolPolicy: { enabled: true, allowedToolkits: ["stripe"], allowedConnectionIds: ["conn_1"], allowExternalWrites: false, version: 1 },
  });

  const saved = await getVoiceCallProfile(504);
  const resolved = resolveOutboundVoiceCallProfile(saved, {
    identity: "Invented caller",
    organization: "Wrong business",
    contactName: "Avery",
    mode: "sales",
    tone: "direct",
    toolPolicy: { enabled: true, allowedToolkits: ["gmail"], allowExternalWrites: true },
  });

  assert.equal(resolved.identity, "Maya");
  assert.equal(resolved.organization, "MedVault");
  assert.equal(resolved.mode, "support");
  assert.equal(resolved.tone, "warm");
  assert.equal(resolved.contactName, "Avery");
  assert.deepEqual(resolved.guardrails, ["Record the caller's report exactly."]);
  assert.deepEqual(resolved.toolPolicy?.allowedToolkits, ["stripe"]);
  assert.deepEqual(resolved.toolPolicy?.allowedConnectionIds, ["conn_1"]);
  assert.equal(resolved.toolPolicy?.allowExternalWrites, false);
});

test("Twilio snapshots the saved representative when chat starts a call", async () => {
  await initStore({ memoryOnly: true });
  await setVoiceCallProfile(505, {
    identity: "Maya",
    organization: "MedVault",
    mode: "support",
    tone: "warm",
    capabilities: ["call_history"],
  });
  const call = await startTwilioCallForUser(505, {
    phoneNumber: "+15550001",
    purpose: "Check in",
    callProfile: "business",
    profile: { identity: "Wrong identity", organization: "Wrong business", tone: "direct" },
  }, {
    enabled: true, accountSid: "AC123", authToken: "auth", callerId: "+16452437121",
    webhookBaseUrl: "https://chusky.example", mediaStreamUrl: "wss://voice.example/twilio/stream", mediaBridgeSecret: "bridge-secret",
    createCall: async () => ({ sid: "CA-saved-profile" }),
  });
  assert.equal(call.voiceProfile?.identity, "Maya");
  assert.equal(call.voiceProfile?.organization, "MedVault");
  assert.equal(call.voiceProfile?.tone, "warm");
});

test("business calls carry a separate call profile", async () => {
  await initStore({ memoryOnly: true });
  const call = await startTwilioCallForUser(503, { phoneNumber: "+15550001", purpose: "Collections", callProfile: "business" }, {
    enabled: true, accountSid: "AC123", authToken: "auth", callerId: "+16452437121",
    webhookBaseUrl: "https://chusky.example", mediaStreamUrl: "wss://voice.example/twilio/stream", mediaBridgeSecret: "bridge-secret", createCall: async () => ({ sid: "CA-business" }),
  });
  assert.equal(call.callProfile, "business");
  assert.equal(call.voiceProfile?.identity, "Chusky");
  assert.equal(call.voiceProfile?.toolPolicy?.enabled, true);
});
