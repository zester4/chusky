import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, listPhoneCalls } from "../src/store.js";
import { inboundTwilioOwner, parseTwilioCallerAllowlist, parseTwilioInboundVoiceProfile, registerTwilioInboundCall, twilioInboundCallerAllowed } from "../src/calls/twilioInbound.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("Twilio inbound settings require an explicit E.164 allowlist and owner", () => {
  assert.deepEqual(parseTwilioCallerAllowlist("+233550472834, +16452437121,+233550472834"), ["+233550472834", "+16452437121"]);
  assert.equal(inboundTwilioOwner("7906015891"), 7906015891);
  assert.throws(() => parseTwilioCallerAllowlist("550472834"), /E.164/);
  assert.throws(() => inboundTwilioOwner("0"), /positive/);
  assert.equal(twilioInboundCallerAllowed("personal", ["+233550472834"], "+233550472834"), true);
  assert.equal(twilioInboundCallerAllowed("personal", ["+233550472834"], "+16452437121"), false);
  assert.equal(twilioInboundCallerAllowed("business", [], "+16452437121"), true);
});

test("Twilio inbound records are owner-scoped and idempotent by provider Call SID", async () => {
  const input = { userId: 71, from: "+233550472834", to: "+16452437121", callSid: "CA1234567890abcdef" };
  const first = await registerTwilioInboundCall(input);
  const replay = await registerTwilioInboundCall(input);
  assert.equal(first.id, replay.id);
  assert.equal(first.callVerification, "verified");
  assert.equal(first.direction, "inbound");
  assert.equal(first.status, "bridging");
  assert.equal(first.providerStatus, "initiated");
  assert.equal((await listPhoneCalls(71)).length, 1);
  await assert.rejects(() => registerTwilioInboundCall({ ...input, from: "not-a-number" }), /Invalid/);
});

test("Twilio inbound profile is explicit and preserves the business tool boundary", () => {
  const profile = parseTwilioInboundVoiceProfile(JSON.stringify({
    identity: "Front Desk",
    organization: "Acme Barber",
    mode: "scheduling",
    toolPolicy: { enabled: true, allowedToolkits: ["googlecalendar"], allowExternalWrites: false },
  }), "business");
  assert.equal(profile.organization, "Acme Barber");
  assert.equal(profile.mode, "scheduling");
  assert.deepEqual(profile.toolPolicy.allowedToolkits, ["googlecalendar"]);
  assert.equal(profile.toolPolicy.allowExternalWrites, false);
  assert.throws(() => parseTwilioInboundVoiceProfile("not-json", "business"), /valid JSON/);
});
