import test from "node:test";
import assert from "node:assert/strict";
import { ensureXchatActivitySubscriptions } from "../src/channels/xchatSetup.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("XChat setup resolves the bot and creates only missing activity subscriptions", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const result = await ensureXchatActivitySubscriptions({
    accessToken: "bot-token",
    webhookId: "webhook-1",
    expectedUsername: "@chusky_bot",
    apiBaseUrl: "https://x.test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? JSON.parse(await request.text()) : undefined;
      calls.push({ url: request.url, method: request.method, body });
      if (request.url.endsWith("/2/users/me")) return json({ data: { id: "42", username: "chusky_bot" } });
      if (request.url.endsWith("/2/activity/subscriptions") && request.method === "GET") {
        return json({ data: [{ event_type: "chat.received", webhook_id: "webhook-1", filter: { user_id: "42" } }] });
      }
      return json({ data: { id: "new-subscription" } }, 201);
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.botUserId, "42");
  assert.equal(result.botUsername, "chusky_bot");
  assert.deepEqual(result.subscriptions, [
    { eventType: "chat.received", status: "existing" },
    { eventType: "chat.conversation.join", status: "created" },
  ]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2]?.body, {
    event_type: "chat.conversation.join",
    filter: { user_id: "42" },
    tag: "chusky-xchat-conversation-join",
    webhook_id: "webhook-1",
  });
});

test("XChat setup fails closed when the webhook ID or token owner is wrong", async () => {
  const missing = await ensureXchatActivitySubscriptions({ accessToken: "bot-token", webhookId: "" });
  assert.equal(missing.status, "misconfigured");
  assert.match(missing.error ?? "", /XCHAT_WEBHOOK_ID/);

  const mismatch = await ensureXchatActivitySubscriptions({
    accessToken: "bot-token",
    webhookId: "webhook-1",
    expectedUsername: "personal-account",
    fetchImpl: async () => json({ data: { id: "42", username: "chusky_bot" } }),
  });
  assert.equal(mismatch.status, "misconfigured");
  assert.match(mismatch.error ?? "", /does not match/);
});
