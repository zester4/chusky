import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, listFaceTimeCalls } from "../src/store.js";
import { startFaceTimeCallForUser } from "../src/calls/facetime.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

const options = {
  enabled: true, apiKey: "key", apiSecret: "secret", fromNumber: "+15550002",
  bridgeUrl: "https://bridge.example/calls", bridgeSecret: "bridge-secret",
  startCall: async () => ({ status: "OK", message: "Call started", agora: { appId: "app", channelName: "channel", token: "short-lived-token", uid: 7 } }),
};

test("FaceTime handoff stores safe metadata but passes the short-lived token only to the bridge", async () => {
  let bridgeBody: any;
  const result = await startFaceTimeCallForUser(91, { phoneNumber: "+15550001", purpose: "Confirm the delivery window" }, {
    ...options,
    fetchImpl: async (_url, init) => {
      bridgeBody = JSON.parse(String(init?.body));
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer bridge-secret");
      return new Response(JSON.stringify({ sessionId: "bridge_1" }), { status: 202 });
    },
  });
  assert.equal(result.status, "bridging");
  assert.equal(result.bridgeSessionId, "bridge_1");
  assert.equal(bridgeBody.agora.token, "short-lived-token");
  const stored = await listFaceTimeCalls(91);
  assert.equal(stored.length, 1);
  assert.equal("agora" in stored[0], false);
  assert.equal(JSON.stringify(stored[0]).includes("short-lived-token"), false);
});

test("FaceTime refuses a provider side effect when the media bridge is not configured", async () => {
  let called = false;
  await assert.rejects(() => startFaceTimeCallForUser(92, { phoneNumber: "+15550001", purpose: "Test" }, { ...options, bridgeUrl: "", startCall: async () => { called = true; return options.startCall("", ""); } }), /MEDIA_BRIDGE/);
  assert.equal(called, false);
});

test("FaceTime bridge failure is retained without retaining provider credentials", async () => {
  await assert.rejects(() => startFaceTimeCallForUser(93, { phoneNumber: "+15550001", purpose: "Test" }, { ...options, fetchImpl: async () => new Response("no", { status: 503 }) }), /media bridge rejected/);
  const stored = await listFaceTimeCalls(93);
  assert.equal(stored[0].status, "failed");
  assert.equal(JSON.stringify(stored[0]).includes("short-lived-token"), false);
});
