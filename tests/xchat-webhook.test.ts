import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ChannelGateway } from "../src/channels/gateway.js";
import { registerChannelRoutes } from "../src/channels/routes.js";
import { XchatAdapter } from "../src/channels/xchat.js";
import { XAdapter } from "../src/channels/x.js";

test("X regular and XChat webhooks delegate GET challenges and POST events to their official adapters", async () => {
  const app = new Hono();
  const x = new XAdapter({ userAccessToken: "token", consumerSecret: "secret", processInbound: async () => undefined });
  const xchat = new XchatAdapter({ accessToken: "token", consumerSecret: "secret", processInbound: async () => undefined });
  const received: Array<{ provider: string; method: string; path: string }> = [];
  x.handleWebhook = async (request) => {
    received.push({ provider: "x", method: request.method, path: new URL(request.url).pathname });
    return new Response("x adapter");
  };
  xchat.handleWebhook = async (request) => {
    received.push({ provider: "xchat", method: request.method, path: new URL(request.url).pathname });
    return new Response("xchat adapter");
  };
  registerChannelRoutes(app, { gateway: new ChannelGateway(async () => undefined), x: { adapter: x }, xchat: { adapter: xchat } });

  for (const path of ["/x/webhook", "/xchat/webhook"]) {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.request(`http://localhost${path}`, { method });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /adapter/);
    }
  }
  assert.deepEqual(received, [
    { provider: "x", method: "GET", path: "/x/webhook" },
    { provider: "x", method: "POST", path: "/x/webhook" },
    { provider: "xchat", method: "GET", path: "/xchat/webhook" },
    { provider: "xchat", method: "POST", path: "/xchat/webhook" },
  ]);
});
