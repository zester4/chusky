import test from "node:test";
import assert from "node:assert/strict";
import { initStore, listFaceTimeCalls } from "../src/store.js";
import { startBlandCallForUser } from "../src/calls/bland.js";

test("Bland queues an owner-scoped call with context and signed-callback URL", async () => {
  await initStore({ memoryOnly: true });
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await startBlandCallForUser(808, { phoneNumber: "+15550001", purpose: "Confirm the appointment", context: "The customer prefers mornings." }, {
    enabled: true,
    apiKey: "bland-key",
    webhookUrl: "https://chusky.example/bland/webhook",
    voice: "maya",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ status: "success", call_id: "bland-provider-call" }), { status: 200 });
    },
  });
  assert.equal(result.provider, "bland");
  assert.equal(result.status, "bridging");
  assert.equal(request?.url, "https://api.bland.ai/v1/calls");
  const body = JSON.parse(String(request?.init?.body));
  assert.equal(body.phone_number, "+15550001");
  assert.equal(body.webhook, "https://chusky.example/bland/webhook");
  assert.match(body.task, /customer prefers mornings/);
  assert.equal((await listFaceTimeCalls(808))[0]?.providerCallId, "bland-provider-call");
});

test("Bland refuses to call when disabled", async () => {
  await assert.rejects(() => startBlandCallForUser(809, { phoneNumber: "+15550001", purpose: "Test" }, {
    enabled: false, apiKey: "", webhookUrl: "", voice: "maya",
  }), /Bland voice is disabled/);
});
