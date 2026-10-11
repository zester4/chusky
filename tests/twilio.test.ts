import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, listPhoneCalls, updatePhoneCall } from "../src/store.js";
import { controlTwilioCallForUser, startTwilioCallForUser, twilioControlTwiML, twilioVoicemailTwiML, validateTwilioCallControl } from "../src/calls/twilio.js";
import { inboundTwilioOwnerForNumber, parseTwilioInboundRoutes } from "../src/calls/twilioInbound.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

const options = {
  enabled: true,
  accountSid: "AC123",
  authToken: "auth-token",
  callerId: "+16452437121",
  webhookBaseUrl: "https://chusky.example",
  mediaStreamUrl: "wss://voice.example/twilio/stream",
};

test("Twilio call uses signed-callback URLs and retains no credentials", async () => {
  let request: { to: string; from: string; url: string; statusCallback: string } | undefined;
  const result = await startTwilioCallForUser(61, { phoneNumber: "+15550001", purpose: "Confirm an appointment" }, {
    ...options,
    createCall: async (input) => { request = input; return { sid: "CA123" }; },
  });
  assert.equal(result.provider, "twilio");
  assert.equal(result.status, "bridging");
  assert.equal(result.providerCallId, "CA123");
  assert.equal(request?.to, "+15550001");
  assert.equal(request?.from, "+16452437121");
  assert.match(request?.url ?? "", /^https:\/\/chusky\.example\/twilio\/twiml\?callId=twc_/);
  assert.match(request?.url ?? "", /&userId=61$/);
  assert.match(request?.statusCallback ?? "", /^https:\/\/chusky\.example\/twilio\/status\?callId=twc_/);
  const stored = await listPhoneCalls(61);
  assert.equal(JSON.stringify(stored).includes("auth-token"), false);
  assert.equal(JSON.stringify(stored).includes("AC123"), false);
});

test("Twilio refuses provider work before required config is present", async () => {
  let called = false;
  await assert.rejects(() => startTwilioCallForUser(62, { phoneNumber: "+15550001", purpose: "Test" }, {
    ...options, mediaStreamUrl: "", createCall: async () => { called = true; return { sid: "CA123" }; },
  }), /TWILIO_MEDIA_STREAM_URL/);
  assert.equal(called, false);
});

test("Twilio call controls validate and render safe DTMF and transfer TwiML", () => {
  assert.deepEqual(validateTwilioCallControl({ action: "send_dtmf", digits: "1,2#w" }), { action: "send_dtmf", digits: "1,2#w" });
  assert.match(twilioControlTwiML({ action: "send_dtmf", digits: "12#" }, options.callerId), /<Play digits="12#"\/>/);
  assert.match(twilioControlTwiML({ action: "transfer", phoneNumber: "+15550002" }, options.callerId), /<Number>\+15550002<\/Number>/);
  assert.throws(() => validateTwilioCallControl({ action: "send_dtmf", digits: "1;DROP" }), /DTMF/);
  assert.throws(() => validateTwilioCallControl({ action: "transfer", phoneNumber: "5550002" }), /E\.164/);
});

test("Twilio voicemail mode requests DetectMessageEnd and renders escaped voicemail TwiML", async () => {
  let request: { machineDetection?: string } | undefined;
  await startTwilioCallForUser(65, { phoneNumber: "+15550005", purpose: "Leave a message" }, {
    ...options,
    machineDetection: "DetectMessageEnd",
    voicemailMessage: "Call back <soon> & thanks",
    createCall: async (input) => { request = input; return { sid: "CA_VOICEMAIL" }; },
  });
  assert.equal(request?.machineDetection, "DetectMessageEnd");
  assert.match(twilioVoicemailTwiML("Call back <soon> & thanks"), /Call back &lt;soon&gt; &amp; thanks/);
  assert.match(twilioVoicemailTwiML("Goodbye"), /<Hangup\/>/);
});

test("inbound Twilio routes choose an explicit destination owner and preserve the fallback", () => {
  assert.deepEqual([...parseTwilioInboundRoutes("+15550001=71,+15550002=72")], [["+15550001", 71], ["+15550002", 72]]);
  assert.equal(inboundTwilioOwnerForNumber("+15550001", "70", "+15550001=71"), 71);
  assert.equal(inboundTwilioOwnerForNumber("+15550003", "70", "+15550001=71"), 70);
  assert.throws(() => parseTwilioInboundRoutes("+15550001=not-an-owner"), /positive owner IDs/);
});

test("owner-scoped Twilio control updates the provider once and persists the result", async () => {
  const started = await startTwilioCallForUser(63, { phoneNumber: "+15550003", purpose: "Control test" }, {
    ...options,
    createCall: async () => ({ sid: "CA_CONTROL" }),
  });
  const updates: Array<{ sid: string; input: unknown }> = [];
  const controlled = await controlTwilioCallForUser(63, started.id, { action: "send_dtmf", digits: "9#" }, {
    ...options,
    updateCall: async (sid, input) => { updates.push({ sid, input }); },
  });
  assert.equal(controlled.status, "active");
  assert.deepEqual(updates, [{ sid: "CA_CONTROL", input: { twiml: twilioControlTwiML({ action: "send_dtmf", digits: "9#" }, options.callerId) } }]);
});

test("owner-scoped Twilio hangup ends the local call after provider confirmation", async () => {
  const started = await startTwilioCallForUser(64, { phoneNumber: "+15550004", purpose: "Hangup test" }, {
    ...options,
    createCall: async () => ({ sid: "CA_HANGUP" }),
  });
  const updates: Array<{ sid: string; input: unknown }> = [];
  const controlled = await controlTwilioCallForUser(64, started.id, { action: "hangup" }, {
    ...options,
    updateCall: async (sid, input) => { updates.push({ sid, input }); },
  });
  assert.equal(controlled.status, "ended");
  assert.deepEqual(updates, [{ sid: "CA_HANGUP", input: { status: "completed" } }]);
});

test("Twilio continuity carries only the prior owner's bounded ended outcome", async () => {
  const prior = await startTwilioCallForUser(66, { phoneNumber: "+15550006", purpose: "First conversation" }, { ...options, createCall: async () => ({ sid: "CA_PRIOR" }) });
  await updatePhoneCall(66, prior.id, { status: "ended", outcome: { title: "Follow-up", summary: "Customer requested a proposal.", decisions: ["Prepare proposal"], actionItems: [{ task: "Draft proposal", owner: "Chusky" }], openQuestions: [] }, outcomeStatus: "completed" });
  const next = await startTwilioCallForUser(66, { phoneNumber: "+15550007", purpose: "Continue the conversation", continuityFromCallId: prior.id }, { ...options, createCall: async () => ({ sid: "CA_NEXT" }) });
  assert.deepEqual(next.continuity, { sourceCallId: prior.id, summary: "Customer requested a proposal.", decisions: ["Prepare proposal"], actionItems: ["Draft proposal (Chusky)"] });
  await assert.rejects(() => startTwilioCallForUser(67, { phoneNumber: "+15550007", purpose: "Cross-owner attempt", continuityFromCallId: prior.id }, { ...options, createCall: async () => ({ sid: "CA_BAD" }) }), /continuity source call/);
});
