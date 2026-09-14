import test from "node:test";
import assert from "node:assert/strict";
import { initStore, listPhoneCalls, setLiveVoicePreference } from "../src/store.js";
import { isBlandVoiceConfigured, startBlandCallForUser } from "../src/calls/bland.js";

test("Bland queues an owner-scoped call with the provisioned custom-tool ID", async () => {
  await initStore({ memoryOnly: true });
  await setLiveVoicePreference(808, "bland", { id: "11111111-1111-4111-8111-111111111111", name: "Zoe" });
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await startBlandCallForUser(808, { phoneNumber: "+15550001", purpose: "Confirm the appointment" }, {
    enabled: true,
    apiKey: "bland-key",
    webhookUrl: "https://chusky.example/bland/webhook",
    webhookSecret: "a-secure-test-secret-that-is-long-enough",
    consultToolId: "TL-1234567890",
    consultToolSecret: "a-second-secure-test-secret-long-enough",
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
  assert.match(body.webhook, /^https:\/\/chusky\.example\/bland\/webhook\/[A-Za-z0-9_.-]+$/);
  assert.equal(body.voice, "11111111-1111-4111-8111-111111111111");
  assert.equal(body.model, undefined);
  assert.match(body.task, /Chusky/);
  assert.equal(body.webhook_events.join(","), "queue,call,latency,tool");
  assert.deepEqual(body.tools, ["TL-1234567890"]);
  assert.equal((await listPhoneCalls(808))[0]?.providerCallId, "bland-provider-call");
});

test("Bland refuses to call when disabled", async () => {
  await assert.rejects(() => startBlandCallForUser(809, { phoneNumber: "+15550001", purpose: "Test" }, {
    enabled: false, apiKey: "", webhookUrl: "", webhookSecret: "", consultToolId: "", consultToolSecret: "", voice: "maya",
  }), /Bland voice is disabled/);
});

test("Bland refuses to dial without a callback-signing secret", async () => {
  await assert.rejects(() => startBlandCallForUser(810, { phoneNumber: "+15550001", purpose: "Test" }, {
    enabled: true, apiKey: "bland-key", webhookUrl: "https://chusky.example/bland/webhook", webhookSecret: "", consultToolId: "TL-1234567890", consultToolSecret: "a-second-secure-test-secret-long-enough", voice: "maya",
    fetchImpl: async () => { throw new Error("must not reach provider"); },
  }), /BLAND_WEBHOOK_SECRET/);
});

test("Bland readiness requires distinct signing/tool secrets and a provisioned v1 tool ID", () => {
  const ready = {
    enabled: true, apiKey: "key", webhookUrl: "https://chusky.example/bland/webhook",
    webhookSecret: "a-secure-webhook-signing-secret-that-is-long-enough",
    consultToolId: "TL-1234567890", consultToolSecret: "a-distinct-url-safe-tool-secret-with-entropy",
  };
  assert.equal(isBlandVoiceConfigured(ready), true);
  assert.equal(isBlandVoiceConfigured({ ...ready, consultToolId: "" }), false);
  assert.equal(isBlandVoiceConfigured({ ...ready, consultToolSecret: ready.webhookSecret }), false);
  assert.equal(isBlandVoiceConfigured({ ...ready, webhookUrl: "http://chusky.example/bland/webhook" }), false);
});
