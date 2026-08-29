import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { deliverWebhook, isSafeWebhookUrl, openWebhookSecret, sealWebhookSecret, signWebhook } from "../src/lib/webhooks.js";

test("webhook URLs reject localhost and private network literals", () => {
  assert.equal(isSafeWebhookUrl(new URL("https://hooks.example.test/path")), true);
  for (const url of ["https://localhost/hook", "https://127.0.0.1/hook", "https://10.0.0.2/hook", "https://169.254.169.254/latest", "http://hooks.example.test/hook"]) assert.equal(isSafeWebhookUrl(new URL(url)), false);
});

test("webhook secrets are encrypted at rest and delivery signatures are stable", () => {
  (config as { apiKey: string }).apiKey = "test-server-key";
  const secret = "whsec_private-value";
  const ciphertext = sealWebhookSecret(secret);
  assert.notEqual(ciphertext, secret);
  assert.equal(openWebhookSecret(ciphertext), secret);
  const first = signWebhook(secret, '{"type":"run.completed"}', 1700000000);
  const second = signWebhook(secret, '{"type":"run.completed"}', 1700000000);
  assert.deepEqual(first, second);
  assert.match(first.signature, /^v1=[a-f0-9]{64}$/);
});

test("webhook delivery sends signed bounded JSON", async () => {
  (config as { apiKey: string }).apiKey = "test-server-key";
  let request: Request | undefined;
  const result = await deliverWebhook({ id: "wh_1", url: "https://example.test/hook", secretCiphertext: sealWebhookSecret("whsec_test") }, { type: "run.completed" }, (async (input: string | URL | Request, init?: RequestInit) => { request = new Request(input, init); return new Response(null, { status: 204 }); }) as typeof fetch);
  assert.equal(result.delivered, true); assert.equal(request?.headers.get("x-chusky-webhook-id"), "wh_1"); assert.match(request?.headers.get("x-chusky-webhook-signature") ?? "", /^v1=/);
});
