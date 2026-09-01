import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, listFaceTimeCalls } from "../src/store.js";
import { startTwilioCallForUser } from "../src/calls/twilio.js";

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
  const stored = await listFaceTimeCalls(61);
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
