import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CHANNEL_CAPABILITIES } from "../src/channels/capabilities.js";
import { ChannelGateway } from "../src/channels/gateway.js";
import { linkChannelIdentity } from "../src/channels/identity.js";
import { ChannelOutbox } from "../src/channels/outbox.js";
import { ChannelDebouncer } from "../src/channels/debounce.js";
import { normalizeSlackEvent, parseSlackInteraction, SlackAdapter, verifySlackSignature } from "../src/channels/slack.js";
import { normalizeWhatsAppPayload, verifyWhatsAppChallenge, verifyWhatsAppSignature, WhatsAppAdapter } from "../src/channels/whatsapp.js";
import { registerChannelRoutes } from "../src/channels/routes.js";
import { Hono } from "hono";
import { acquireUserLock, getOutbox, initStore, releaseUserLock, renewUserLock } from "../src/store.js";
import type { ChannelAdapter, DeliveryReceipt, OutboundMessage } from "../src/channels/contracts.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("Slack signatures require the exact raw body and a fresh timestamp", () => {
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev1" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  assert.doesNotThrow(() => verifySlackSignature(body, { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, "secret"));
  assert.throws(() => verifySlackSignature(body + " ", { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, "secret"), /Invalid Slack/);
  assert.throws(() => verifySlackSignature(body, { "x-slack-request-timestamp": String(Number(timestamp) - 601), "x-slack-signature": signature }, "secret"), /Invalid or stale/);
});

test("Slack normalization preserves workspace, DM/thread scope, and strips mentions", () => {
  const dm = normalizeSlackEvent({ type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "message", user: "U1", channel: "D1", channel_type: "im", text: "hello <@B1>", ts: "1.2" } });
  assert.equal(dm?.scope, "private");
  assert.equal(dm?.text, "hello");
  assert.equal(dm?.providerWorkspaceId, "T1");
  const mention = normalizeSlackEvent({ type: "event_callback", event_id: "Ev2", team_id: "T1", event: { type: "app_mention", user: "U1", channel: "C1", text: "<@B1> summarize", thread_ts: "9.1" } });
  assert.equal(mention?.scope, "shared");
  assert.equal(mention?.providerThreadId, "9.1");
  assert.equal(normalizeSlackEvent({ type: "event_callback", event_id: "Ev3", team_id: "T1", event: { type: "message", bot_id: "B1", user: "U1", channel: "D1" } }), undefined);
});

test("Slack interaction parsing produces an approval interaction without trusting display names", () => {
  const raw = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", trigger_id: "tr1", team: { id: "T1" }, user: { id: "U1", name: "spoofable" }, channel: { id: "D1" }, message: { ts: "2.3" }, actions: [{ action_id: "chusky_approval_approve", value: "appr_1" }] }))}`;
  const parsed = parseSlackInteraction(raw);
  assert.equal(parsed?.message.providerUserId, "U1");
  assert.equal(parsed?.message.interaction?.value, "appr_1");
  assert.equal(parsed?.interaction.workspaceId, "T1");
});

test("WhatsApp signatures and verification challenges are strict", () => {
  const body = "{\"object\":\"whatsapp_business_account\"}";
  const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
  assert.doesNotThrow(() => verifyWhatsAppSignature(body, { "x-hub-signature-256": signature }, "app-secret"));
  assert.throws(() => verifyWhatsAppSignature(body, { "x-hub-signature-256": "sha256=bad" }, "app-secret"), /Invalid WhatsApp/);
  assert.equal(verifyWhatsAppChallenge("subscribe", "verify", "challenge", "verify"), "challenge");
  assert.throws(() => verifyWhatsAppChallenge("subscribe", "wrong", "challenge", "verify"), /Invalid WhatsApp/);
});

test("WhatsApp normalization accepts text and media without persisting raw payloads", () => {
  const message = normalizeWhatsAppPayload({ object: "whatsapp_business_account", entry: [{ id: "WBA", changes: [{ value: { metadata: { phone_number_id: "P1" }, contacts: [{ profile: { name: "Joe" } }], messages: [{ id: "wamid.1", from: "15550001", type: "image", image: { id: "media.1", mime_type: "image/jpeg" } }] } }] }] });
  assert.equal(message?.provider, "whatsapp");
  assert.equal(message?.providerWorkspaceId, "P1");
  assert.equal(message?.attachments[0].id, "media.1");
  assert.equal(message?.displayName, "Joe");
});

test("WhatsApp bursts are merged by a Redis-backed debounce queue", async () => {
  const debouncer = new ChannelDebouncer(10);
  const results: string[] = [];
  const base = (id: string, text: string) => ({ provider: "whatsapp" as const, providerEventId: id, providerUserId: "1555", providerWorkspaceId: "P1", providerConversationId: "1555", text, attachments: [], receivedAt: Date.now(), scope: "private" as const });
  await debouncer.push(base("m1", "first"), async (message) => { results.push(`${message.providerEventId}:${message.text}`); });
  await debouncer.push(base("m2", "second"), async (message) => { results.push(`${message.providerEventId}:${message.text}`); });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(results, ["debounce:m1:m2:first\nsecond"]);
});

class FakeAdapter implements ChannelAdapter {
  readonly provider = "slack" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.slack;
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage): Promise<DeliveryReceipt> { this.sent.push(message); return { providerMessageId: `m${this.sent.length}`, deliveredAt: Date.now() }; }
}

const inbound = (id: string, text = "hello") => ({ provider: "slack" as const, providerEventId: id, providerUserId: "U1", providerWorkspaceId: "T1", providerConversationId: "D1", text, attachments: [], receivedAt: Date.now(), scope: "private" as const });

test("channel identity ownership and gateway event deduplication are durable boundaries", async () => {
  await linkChannelIdentity(42, { provider: "slack", externalUserId: "U1", workspaceId: "T1" });
  await assert.rejects(() => linkChannelIdentity(43, { provider: "slack", externalUserId: "U1", workspaceId: "T1" }), /already linked/);
  const adapter = new FakeAdapter();
  const gateway = new ChannelGateway(async (_message, conversation) => ({ accountId: conversation.accountId, userId: conversation.userId, target: conversation.replyTarget, text: "done", idempotencyKey: "reply:event-1" }));
  gateway.register(adapter);
  const first = await gateway.processInbound(inbound("event-1"));
  const second = await gateway.processInbound(inbound("event-1"));
  assert.equal(first.linked, true);
  assert.equal(second.duplicate, true);
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].accountId, "account_42");
});

test("outbox idempotency prevents duplicate provider sends and records receipts", async () => {
  const adapter = new FakeAdapter();
  const outbox = new ChannelOutbox();
  const message: OutboundMessage = { accountId: "account_42", userId: 42, target: { provider: "slack", conversationId: "D1" }, text: "once", idempotencyKey: "stable-1" };
  const first = await outbox.send(message, adapter);
  const second = await outbox.send(message, adapter);
  assert.equal(first.id, second.id);
  assert.equal(adapter.sent.length, 1);
  assert.equal((await getOutbox(first.id))?.status, "delivered");
});

test("account locks can be renewed and only the owner can release them", async () => {
  assert.equal(await acquireUserLock(77, "a", 1), true);
  assert.equal(await acquireUserLock(77, "b", 1), false);
  assert.equal(await renewUserLock(77, "b", 1), false);
  assert.equal(await renewUserLock(77, "a", 1), true);
  await releaseUserLock(77, "b");
  assert.equal(await acquireUserLock(77, "b", 1), false);
  await releaseUserLock(77, "a");
  assert.equal(await acquireUserLock(77, "b", 1), true);
  await releaseUserLock(77, "b");
});

test("provider adapters use channel-specific delivery APIs", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: "3.4", channel: "D1", messages: [{ id: "wamid.2" }] }), { status: 200 });
  }) as typeof fetch;
  await new SlackAdapter("xoxb-token", fakeFetch).send({ accountId: "account_1", userId: 1, target: { provider: "slack", conversationId: "D1", workspaceId: "T1" }, text: "hi", idempotencyKey: "s1" });
  await new WhatsAppAdapter("token", "P1", "v23.0", fakeFetch).send({ accountId: "account_1", userId: 1, target: { provider: "whatsapp", conversationId: "1555" }, text: "hi", idempotencyKey: "w1" });
  assert.equal(requests[0].url.endsWith("/chat.postMessage"), true);
  assert.equal(requests[1].url.includes("/P1/messages"), true);
});

test("webhook routes return non-2xx for invalid provider signatures", async () => {
  const app = new Hono();
  const slack = new SlackAdapter("token", (async () => new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 })) as typeof fetch);
  const whatsapp = new WhatsAppAdapter("token", "P1", "v23.0", (async () => new Response(JSON.stringify({ messages: [{ id: "1" }] }), { status: 200 })) as typeof fetch);
  registerChannelRoutes(app, { gateway: new ChannelGateway(async () => undefined), slack: { adapter: slack, signingSecret: "secret" }, whatsapp: { adapter: whatsapp, appSecret: "app-secret", verifyToken: "verify" } });
  const slackResponse = await app.request("http://localhost/slack/events", { method: "POST", body: "{}", headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=bad" } });
  const whatsappResponse = await app.request("http://localhost/whatsapp/webhook", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=bad" } });
  assert.equal(slackResponse.status, 401);
  assert.equal(whatsappResponse.status, 401);
});
