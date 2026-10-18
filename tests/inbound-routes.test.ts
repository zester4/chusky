import test from "node:test";
import assert from "node:assert/strict";
import { blandRouteFromRecord, normalizeInboundPhone, normalizeVoiceInboundRouteInput, twilioRouteCallerAllowed } from "../src/calls/inboundRoutes.js";
import { providerStatusCanAdvance } from "../src/calls/voiceEvents.js";
import { deleteVoiceInboundRoute, getVoiceInboundRoute, hasVoiceInboundRoutes, initStore, listVoiceInboundRoutes, saveVoiceInboundRoute } from "../src/store.js";

test("durable inbound routes normalize phones and reject unsafe personal defaults", () => {
  assert.equal(normalizeInboundPhone("+1 (555) 010-0123"), "+15550100123");
  assert.throws(() => normalizeVoiceInboundRouteInput({ provider: "twilio", phoneNumber: "+15550100123", callProfile: "personal" }, 42), /allowed caller/i);
  const route = normalizeVoiceInboundRouteInput({
    provider: "twilio",
    phoneNumber: "+1 (555) 010-0123",
    callProfile: "business",
    purpose: "Book appointments",
    voiceProfile: { identity: "Dr. Unsafe", organization: "Example Clinic", mode: "scheduling" },
  }, 42);
  assert.equal(route.phoneNumber, "+15550100123");
  assert.equal(route.voiceProfile.identity, "Chusky");
  assert.equal(route.callProfile, "business");
  assert.equal(twilioRouteCallerAllowed(route, "+233550472834"), true);
  assert.equal(blandRouteFromRecord(route).userId, 42);
});

test("provider lifecycle event projection never regresses after a terminal callback", () => {
  assert.equal(providerStatusCanAdvance("ringing", "in-progress"), true);
  assert.equal(providerStatusCanAdvance("completed", "ringing"), false);
  assert.equal(providerStatusCanAdvance("no-answer", "in-progress"), false);
  assert.equal(providerStatusCanAdvance("unknown", "initiated"), true);
  assert.equal(providerStatusCanAdvance(undefined, "initiated"), true);
});

test("durable inbound routes are tenant-owned and public provider indexes stay accurate", async () => {
  await initStore({ memoryOnly: true });
  const route = normalizeVoiceInboundRouteInput({
    provider: "twilio",
    phoneNumber: "+15550100124",
    callProfile: "business",
    purpose: "Book a service appointment",
  }, 7001);
  assert.equal(await saveVoiceInboundRoute(route), true);
  assert.equal((await getVoiceInboundRoute("twilio", route.phoneNumber))?.userId, 7001);
  assert.equal((await listVoiceInboundRoutes(7001)).length, 1);
  assert.equal((await listVoiceInboundRoutes(7002)).length, 0);
  assert.equal(await hasVoiceInboundRoutes("twilio"), true);

  const foreignUpdate = { ...route, userId: 7002, updatedAt: route.updatedAt + 1 };
  assert.equal(await saveVoiceInboundRoute(foreignUpdate), false);
  assert.equal(await deleteVoiceInboundRoute("twilio", route.phoneNumber, 7002), false);
  assert.equal(await deleteVoiceInboundRoute("twilio", route.phoneNumber, 7001), true);
  assert.equal(await getVoiceInboundRoute("twilio", route.phoneNumber), undefined);
  assert.equal(await hasVoiceInboundRoutes("twilio"), false);
});
