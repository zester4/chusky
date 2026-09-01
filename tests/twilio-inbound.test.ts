import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, listFaceTimeCalls } from "../src/store.js";
import { inboundTwilioOwner, parseTwilioCallerAllowlist, registerTwilioInboundCall } from "../src/calls/twilioInbound.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("Twilio inbound settings require an explicit E.164 allowlist and owner", () => {
  assert.deepEqual(parseTwilioCallerAllowlist("+233550472834, +16452437121,+233550472834"), ["+233550472834", "+16452437121"]);
  assert.equal(inboundTwilioOwner("7906015891"), 7906015891);
  assert.throws(() => parseTwilioCallerAllowlist("550472834"), /E.164/);
  assert.throws(() => inboundTwilioOwner("0"), /positive/);
});

test("Twilio inbound records are owner-scoped and idempotent by provider Call SID", async () => {
  const input = { userId: 71, from: "+233550472834", to: "+16452437121", callSid: "CA1234567890abcdef" };
  const first = await registerTwilioInboundCall(input);
  const replay = await registerTwilioInboundCall(input);
  assert.equal(first.id, replay.id);
  assert.equal(first.direction, "inbound");
  assert.equal(first.status, "bridging");
  assert.equal((await listFaceTimeCalls(71)).length, 1);
  await assert.rejects(() => registerTwilioInboundCall({ ...input, from: "not-a-number" }), /Invalid/);
});
