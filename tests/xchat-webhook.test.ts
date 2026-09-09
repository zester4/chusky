import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { ChannelGateway } from "../src/channels/gateway.js";
import { registerChannelRoutes } from "../src/channels/routes.js";
import { XchatAdapter } from "../src/channels/xchat.js";
import { createXchatCrcResponse } from "../src/channels/xchat.js";

test("XChat CRC response uses the consumer secret and token", () => {
  const token = "crc-test-token";
  const secret = "consumer-secret";
  const expected = createHmac("sha256", secret).update(token).digest("base64");
  assert.deepEqual(createXchatCrcResponse(token, secret), { response_token: `sha256=${expected}` });
});

test("XChat CRC response rejects missing inputs", () => {
  assert.throws(() => createXchatCrcResponse("", "secret"), /requires/);
  assert.throws(() => createXchatCrcResponse("token", ""), /requires/);
});

test("XChat webhook answers CRC without initializing the provider SDK", async () => {
  const app = new Hono();
  const adapter = new XchatAdapter({ accessToken: "test-token", consumerSecret: "test-secret", processInbound: async () => undefined });
  registerChannelRoutes(app, { gateway: new ChannelGateway(async () => undefined), xchat: { adapter, consumerSecret: "test-secret" } });

  const token = "route-crc-token";
  const response = await app.request(`http://localhost/xchat/webhook?crc_token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), createXchatCrcResponse(token, "test-secret"));

  const missing = await app.request("http://localhost/xchat/webhook");
  assert.equal(missing.status, 400);
});
