import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getBlandPhoneCallByProviderId, getPhoneCall, initStore, listPhoneCalls } from "../src/store.js";
import { parseBlandInboundRoutes, resolveBlandInboundRoute } from "../src/calls/blandInbound.js";
import { processBlandWebhook } from "../src/calls/blandWebhooks.js";

const secret = "test-only-bland-inbound-webhook-secret-long-enough";
const route = parseBlandInboundRoutes("+15550000001=901", { callProfile: "business", purpose: "Handle inbound support calls", allowedCallers: ["+15550000002"] }).get("+15550000001")!;
const signed = (body: unknown) => {
  const rawBody = JSON.stringify(body);
  return { rawBody, signature: createHmac("sha256", secret).update(rawBody).digest("hex") };
};

test("Bland inbound routing maps a signed number to an owner and registers the call before tool use", async () => {
  await initStore({ memoryOnly: true });
  const body = { call_id: "bland-inbound-901", inbound: true, to: route.phoneNumber, from: "+15550000003", category: "call", message: "Call started", log_level: "info" };
  const result = await processBlandWebhook({ ...signed(body), inboundRoute: route, secret });
  assert.equal(result.status, 200);
  const call = await getBlandPhoneCallByProviderId(body.call_id);
  assert.equal(call?.userId, route.userId);
  assert.equal(call?.direction, "inbound");
  assert.equal(call?.callProfile, "business");
  assert.equal(call?.callVerification, "identified");
  assert.equal(call?.status, "active");
  assert.equal((await listPhoneCalls(route.userId)).filter((item) => item.providerCallId === body.call_id).length, 1);
});

test("verified Bland inbound callers retain the verified tier and post-call reconciliation is idempotent", async () => {
  await initStore({ memoryOnly: true });
  const body = {
    call_id: "bland-inbound-902", inbound: true, to: route.phoneNumber, from: "+15550000002", completed: true, queue_status: "complete", call_length: 3,
    summary: "The caller asked for support and the owner will follow up.",
    transcripts: [{ id: 1, user: "user", text: "I need support." }, { id: 2, user: "assistant", text: "I will have the owner follow up." }],
  };
  const request = { ...signed(body), inboundRoute: route, secret };
  assert.equal((await processBlandWebhook(request)).status, 200);
  const call = await getBlandPhoneCallByProviderId(body.call_id);
  assert.equal(call?.callVerification, "verified");
  assert.equal(call?.phoneNumber, body.from);
  assert.equal(call?.outcomeStatus, "completed");
  assert.equal((await processBlandWebhook(request)).body.duplicate, true);
  assert.ok(call && await getPhoneCall(route.userId, call.id));
});

test("Bland inbound route resolution rejects a mismatched number and explicit outbound payload", () => {
  const routes = new Map([[route.phoneNumber, route]]);
  const inbound = JSON.stringify({ call_id: "bland-inbound-903", inbound: true, to: route.phoneNumber });
  assert.equal(resolveBlandInboundRoute(inbound, routes, "15550000001"), route);
  assert.equal(resolveBlandInboundRoute(inbound, routes, "15550000009"), undefined);
  assert.equal(resolveBlandInboundRoute(JSON.stringify({ call_id: "bland-inbound-904", inbound: false, to: route.phoneNumber }), routes), undefined);
});
