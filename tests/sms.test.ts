import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTwilioMessage, TwilioSmsAdapter } from "../src/channels/sms.js";

test("normalizes a Twilio inbound SMS and MMS payload", () => {
  const message = normalizeTwilioMessage({
    MessageSid: "SM123",
    From: "+15550001111",
    Body: "  hello Chusky  ",
    NumMedia: "2",
    MediaUrl0: "https://api.twilio.com/media/one",
    MediaContentType0: "image/jpeg",
    MediaUrl1: "https://api.twilio.com/media/two",
    MediaContentType1: "application/pdf",
  }, 123);
  assert.equal(message?.provider, "sms");
  assert.equal(message?.providerEventId, "SM123");
  assert.equal(message?.text, "hello Chusky");
  assert.deepEqual(message?.attachments.map((item) => item.kind), ["image", "document"]);
});

test("sends Twilio SMS through the Messages API", async () => {
  let request: RequestInit | undefined;
  const adapter = new TwilioSmsAdapter({
    accountSid: "AC123",
    authToken: "secret",
    phoneNumber: "+15550002222",
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ sid: "SM456" }), { status: 201, headers: { "Content-Type": "application/json" } });
    },
  });
  const receipt = await adapter.send({
    accountId: "account_1",
    userId: 1,
    target: { provider: "sms", conversationId: "+15550001111" },
    text: "hello",
    idempotencyKey: "run-1",
  });
  assert.equal(receipt.providerMessageId, "SM456");
  assert.equal(request?.method, "POST");
  assert.match(String(request?.headers && new Headers(request.headers).get("Authorization")), /^Basic /);
  assert.equal(new URLSearchParams(String(request?.body)).get("To"), "+15550001111");
  assert.equal(new URLSearchParams(String(request?.body)).get("From"), "+15550002222");
});
