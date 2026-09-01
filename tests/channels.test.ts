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
import { normalizeSendblueMessage, SendblueAdapter, verifySendblueSignature } from "../src/channels/sendblue.js";
import { formatSendblueText } from "../src/channels/sendblueFormatting.js";
import { formatWhatsAppText } from "../src/channels/whatsappFormatting.js";
import { createAgentChannelHandler } from "../src/channels/agentHandler.js";
import { registerChannelRoutes } from "../src/channels/routes.js";
import { Hono } from "hono";
import { parseTelegramWebhookUpdate, verifyTelegramWebhookSecret } from "../src/telegramWebhook.js";
import { acquireUserLock, createSendblueGroupLinkCode, getOutbox, getSendblueGroupAuthorization, initStore, releaseUserLock, renewUserLock } from "../src/store.js";
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

test("Sendblue verifies its webhook secret and normalizes direct and group iMessages", () => {
  const raw = '{"message_handle":"sb-1"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret").update(`${timestamp}.${raw}`).digest("hex");
  assert.doesNotThrow(() => verifySendblueSignature(raw, { "X-Sendblue-Signature": `t=${timestamp},v1=${signature}` }, "secret"));
  assert.throws(() => verifySendblueSignature(raw, { "X-Sendblue-Signature": `t=${timestamp},v1=bad` }, "secret"), /Sendblue webhook signature/);
  assert.throws(() => verifySendblueSignature(raw, { "X-Sendblue-Signature": `t=${Number(timestamp) - 301},v1=${signature}` }, "secret"), /stale/);
  const direct = normalizeSendblueMessage({ message_handle: "sb-1", from_number: "+15550001", sendblue_number: "+15550002", content: "hello", service: "iMessage" });
  assert.equal(direct?.provider, "sendblue");
  assert.equal(direct?.providerConversationId, "+15550001");
  assert.equal(direct?.scope, "private");
  const reply = normalizeSendblueMessage({ message_handle: "sb-3", from_number: "+15550001", sendblue_number: "+15550002", reply_to: { message_handle: "sb-parent" } });
  assert.equal(reply?.providerReplyToId, "sb-parent");
  const group = normalizeSendblueMessage({ message_handle: "sb-2", from_number: "+15550001", sendblue_number: "+15550002", group_id: "group-1", content: "plan this", participants: ["+15550001", "+15550002"] });
  assert.equal(group?.providerConversationId, "group-1");
  assert.equal(group?.scope, "shared");
});

test("Sendblue starts FaceTime with its documented endpoint and never accepts malformed credentials", async () => {
  let request: { url?: string; init?: RequestInit } = {};
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ status: "OK", message: "Call started", agora: { appId: "app", channelName: "channel", token: "short-lived-token", uid: 42 } }), { status: 200 });
  }) as typeof fetch);
  const result = await adapter.startFaceTimeCall("+15550001");
  assert.equal(request.url, "https://api.sendblue.com/facetime/start-call");
  assert.deepEqual(JSON.parse(String(request.init?.body)), { phoneNumber: "+15550001", fromNumber: "+15550002" });
  assert.equal((request.init?.headers as Record<string, string>)["sb-api-key-id"], "key");
  assert.equal(result.agora.channelName, "channel");
  await assert.rejects(() => adapter.startFaceTimeCall("5550001"), /E.164/);
});

test("Sendblue hydrates bounded media for the shared agent handler", async () => {
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png", "content-length": "3" } })) as typeof fetch);
  const hydrated = await adapter.hydrateInbound({ provider: "sendblue", providerEventId: "sb-media", providerUserId: "+15550001", providerConversationId: "+15550001", text: "edit this", attachments: [{ id: "m1", kind: "image", url: "https://cdn.example/image.png" }], receivedAt: Date.now(), scope: "private" });
  assert.match(hydrated.attachments[0].url ?? "", /^data:image\/png;base64,/);
});

test("Sendblue identifies a voice recording from its downloaded MIME type", async () => {
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mp4", "content-length": "3" } })) as typeof fetch);
  const hydrated = await adapter.hydrateInbound({ provider: "sendblue", providerEventId: "sb-voice", providerUserId: "+15550001", providerConversationId: "+15550001", attachments: [{ id: "voice-1", kind: "image", url: "https://cdn.example/media" }], receivedAt: Date.now(), scope: "private" });
  assert.equal(hydrated.attachments[0].kind, "audio");
  assert.equal(hydrated.attachments[0].mimeType, "audio/mp4");
  assert.match(hydrated.attachments[0].url ?? "", /^data:audio\/mp4;base64,/);
});

test("Sendblue media errors return a safe reply instead of silently failing the workflow", async () => {
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/x-caf", "content-length": "3" } })) as typeof fetch);
  const message = await adapter.hydrateInbound({ provider: "sendblue", providerEventId: "sb-caf", providerUserId: "+15550001", providerConversationId: "+15550001", attachments: [{ id: "voice-2", kind: "audio", url: "https://cdn.example/voice" }], receivedAt: Date.now(), scope: "private" });
  assert.equal(message.attachments[0].mediaError, "unsupported_media_type");
  const response = await createAgentChannelHandler()(message, { accountId: "account_42", userId: 42, provider: "sendblue", scope: "private", conversationId: "sendblue:-:+15550001:-", permissions: { canUseAgent: true, canApprove: true, canUseSharedContext: true, canReceiveProactive: true }, replyTarget: { provider: "sendblue", conversationId: "+15550001" } });
  assert.match(response?.text ?? "", /audio format is not supported/i);
});

test("Sendblue converts Markdown into readable iMessage text", () => {
  const result = formatSendblueText("**Today**\n\n- Check email\n- [Open dashboard](https://example.com)\n\n`npm test`");
  assert.equal(result, "Today\n\n• Check email\n• Open dashboard: https://example.com\n\nnpm test");
  assert.equal(result.includes("*"), false);
});

test("WhatsApp converts Markdown into native rich text", () => {
  const result = formatWhatsAppText("# Today\n\n**Important** and *quickly*\n\n- Check [the dashboard](https://example.com)\n- `npm test`\n\n~~old plan~~");
  assert.equal(result, "*Today*\n\n*Important* and _quickly_\n\n• Check the dashboard: https://example.com\n• ```npm test```\n\n~old plan~");
});

test("WhatsApp preserves code blocks while formatting surrounding text", () => {
  const result = formatWhatsAppText("Use **this**:\n\n```ts\nconst value = 1;\n```");
  assert.equal(result, "Use *this*:\n\n```const value = 1;```");
});

test("Sendblue typing indicators use the direct-message API", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  }) as typeof fetch);
  const target = { provider: "sendblue" as const, conversationId: "+15550001" };
  await adapter.typing(target);
  await adapter.stopTyping(target);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.endsWith("/send-typing-indicator"), true);
  assert.equal(requests[0].body.state, "start");
  assert.equal(requests[1].body.state, "stop");
});

test("Sendblue mark-read and tapback reactions use the documented endpoints", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  }) as typeof fetch);
  const target = { provider: "sendblue" as const, conversationId: "+15550001" };
  await adapter.markRead(target);
  await adapter.react(target, "sb-parent", "love");
  assert.equal(requests[0].url.endsWith("/mark-read"), true);
  assert.deepEqual(requests[0].body, { number: "+15550001", from_number: "+15550002" });
  assert.equal(requests[1].url.endsWith("/send-reaction"), true);
  assert.deepEqual(requests[1].body, { from_number: "+15550002", message_handle: "sb-parent", reaction: "love" });
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

test("a Sendblue identity linked in a direct chat can use Chusky in a group", async () => {
  await linkChannelIdentity(42, { provider: "sendblue", externalUserId: "+15550001" });
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ message_handle: "sb-out-1" }), { status: 200 });
  }) as typeof fetch);
  const gateway = new ChannelGateway(async (_message, conversation) => ({
    accountId: conversation.accountId,
    userId: conversation.userId,
    target: conversation.replyTarget,
    text: "Group reply",
    idempotencyKey: "sendblue-group-reply-1",
  }));
  gateway.register(adapter);
  const group = normalizeSendblueMessage({
    message_handle: "sb-group-in-1",
    from_number: "+15550001",
    sendblue_number: "+15550002",
    group_id: "group-1",
    content: "hello group",
    participants: ["+15550001", "+15550002"],
  });
  const result = await gateway.processInbound(group!);
  assert.equal(result.linked, true);
  assert.equal(requests[0].url.endsWith("/send-group-message"), true);
  assert.deepEqual(requests[0].body, {
    from_number: "+15550002",
    content: "Group reply",
    group_id: "group-1",
    reply_to: { message_handle: "sb-group-in-1" },
  });
});

test("a linked owner can authorize a Sendblue group for all participants and unlink it", async () => {
  await linkChannelIdentity(42, { provider: "sendblue", externalUserId: "+15550001" });
  const code = await createSendblueGroupLinkCode(42);
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ message_handle: `sb-out-${requests.length}` }), { status: 200 });
  }) as typeof fetch);
  const seen: string[] = [];
  const gateway = new ChannelGateway(async (message, conversation) => {
    seen.push(`${message.providerUserId}:${conversation.scope}:${conversation.conversationId}`);
    return { accountId: conversation.accountId, userId: conversation.userId, target: conversation.replyTarget, text: "Group reply", idempotencyKey: `group-reply-${message.providerEventId}` };
  });
  gateway.register(adapter);
  const activate = normalizeSendblueMessage({ message_handle: "sb-group-link", from_number: "+15550001", sendblue_number: "+15550002", group_id: "group-1", content: `/link-group ${code}` });
  assert.equal((await gateway.processInbound(activate!)).linked, true);
  assert.equal(await getSendblueGroupAuthorization("group-1", "+15550002") !== undefined, true);
  const participant = normalizeSendblueMessage({ message_handle: "sb-group-chat", from_number: "+15550003", sendblue_number: "+15550002", group_id: "group-1", content: "hello everyone" });
  const result = await gateway.processInbound(participant!);
  assert.equal(result.linked, true);
  assert.deepEqual(seen, ["+15550003:shared:sendblue:+15550002:group-1:-"]);
  assert.equal(requests.at(-1)?.body.group_id, "group-1");
  const unlink = normalizeSendblueMessage({ message_handle: "sb-group-unlink", from_number: "+15550001", sendblue_number: "+15550002", group_id: "group-1", content: "/unlink-group" });
  assert.equal((await gateway.processInbound(unlink!)).linked, true);
  assert.equal(await getSendblueGroupAuthorization("group-1", "+15550002"), undefined);
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

test("Sendblue group metadata survives durable outbox recovery", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new SendblueAdapter("key", "secret", "+15550002", undefined, (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ message_handle: "sb-out-2" }), { status: 200 });
  }) as typeof fetch);
  const outbox = new ChannelOutbox();
  await outbox.enqueue({
    accountId: "account_42",
    userId: 42,
    target: { provider: "sendblue", conversationId: "group-1", metadata: { groupId: "group-1", messageHandle: "sb-group-in-2" } },
    text: "Recovered group reply",
    idempotencyKey: "sendblue-group-recovery-1",
  });
  assert.equal(await outbox.recover(new Map([["sendblue", adapter]])), 1);
  assert.equal(requests[0].url.endsWith("/send-group-message"), true);
  assert.deepEqual(requests[0].body, {
    from_number: "+15550002",
    content: "Recovered group reply",
    group_id: "group-1",
    reply_to: { message_handle: "sb-group-in-2" },
  });
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
  await new SendblueAdapter("key", "secret", "+15550002", undefined, fakeFetch).send({ accountId: "account_1", userId: 1, target: { provider: "sendblue", conversationId: "+15550001", metadata: { messageHandle: "sb-in-1" } }, text: "hi", idempotencyKey: "b1" });
  assert.equal(requests[0].url.endsWith("/chat.postMessage"), true);
  assert.equal(requests[1].url.includes("/P1/messages"), true);
  assert.equal(requests[2].url.endsWith("/send-message"), true);
  assert.equal(requests[2].body.from_number, "+15550002");
});

test("WhatsApp sends approved templates with Meta's documented payload", async () => {
  let request: { url: string; body: any } | undefined;
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    request = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ messages: [{ id: "wamid.template-1" }] }), { status: 200 });
  }) as typeof fetch;
  const adapter = new WhatsAppAdapter("token", "P1", "v23.0", fetcher);
  const outbox = new ChannelOutbox();
  const record = await outbox.send({
    accountId: "account_1", userId: 1, target: { provider: "whatsapp", conversationId: "1555" },
    template: { name: "hello_world", languageCode: "en_US", components: [{ type: "body", parameters: [{ type: "text", text: "Seyyid" }] }] },
    idempotencyKey: "template-1",
  }, adapter);
  assert.equal(record.status, "delivered");
  assert.equal(request?.url, "https://graph.facebook.com/v23.0/P1/messages");
  assert.deepEqual(request?.body, {
    messaging_product: "whatsapp", recipient_type: "individual", to: "1555", type: "template",
    template: { name: "hello_world", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Seyyid" }] }] },
  });
  assert.deepEqual((await getOutbox(record.id))?.template, { name: "hello_world", languageCode: "en_US", components: [{ type: "body", parameters: [{ type: "text", text: "Seyyid" }] }] });
});

test("WhatsApp rejects unsafe or conflicting template messages", async () => {
  const adapter = new WhatsAppAdapter("token", "P1", "v23.0", (async () => new Response(JSON.stringify({ messages: [{ id: "1" }] }), { status: 200 })) as typeof fetch);
  const base = { accountId: "account_1", userId: 1, target: { provider: "whatsapp" as const, conversationId: "1555" }, idempotencyKey: "template-invalid" };
  await assert.rejects(() => adapter.send({ ...base, template: { name: "Hello World", languageCode: "en_US" } }), /template name/);
  await assert.rejects(() => adapter.send({ ...base, template: { name: "hello_world", languageCode: "en_US" }, interactive: { kind: "buttons", body: "Choose", buttons: [{ id: "yes", title: "Yes" }] } }), /cannot be combined/);
});

test("Slack hydrates private files with bounded trusted downloads", async () => {
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://files.slack.com/files-pri/F1/download");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xoxb-token");
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
  }) as typeof fetch;
  const adapter = new SlackAdapter("xoxb-token", fetcher);
  const message = normalizeSlackEvent({ type: "event_callback", event_id: "Ev-file", team_id: "T1", event: { type: "message", user: "U1", channel: "D1", channel_type: "im", text: "read", files: [{ id: "F1", name: "a.txt", mimetype: "text/plain", url_private_download: "https://files.slack.com/files-pri/F1/download" }] } });
  const hydrated = await adapter.hydrateInbound(message!);
  assert.match(hydrated.attachments[0].url!, /^data:text\/plain;base64,/);
});

test("Slack rejects attachment redirects", async () => {
  const adapter = new SlackAdapter("xoxb-token", (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as typeof fetch);
  const message = normalizeSlackEvent({ type: "event_callback", event_id: "Ev-redirect", team_id: "T1", event: { type: "message", user: "U1", channel: "D1", channel_type: "im", files: [{ id: "F1", url_private: "https://files.slack.com/files-pri/F1/download" }] } });
  await assert.rejects(() => adapter.hydrateInbound(message!), /redirect rejected/);
});

test("webhook routes return non-2xx for invalid provider signatures", async () => {
  const app = new Hono();
  const slack = new SlackAdapter("token", (async () => new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 })) as typeof fetch);
  const whatsapp = new WhatsAppAdapter("token", "P1", "v23.0", (async () => new Response(JSON.stringify({ messages: [{ id: "1" }] }), { status: 200 })) as typeof fetch);
  const sendblue = new SendblueAdapter("key", "secret", "+15550002", undefined, (async () => new Response(JSON.stringify({ message_handle: "sb-1" }), { status: 200 })) as typeof fetch);
  registerChannelRoutes(app, { gateway: new ChannelGateway(async () => undefined), slack: { adapter: slack, signingSecret: "secret" }, whatsapp: { adapter: whatsapp, appSecret: "app-secret", verifyToken: "verify" }, sendblue: { adapter: sendblue, webhookSecret: "secret" } });
  const slackResponse = await app.request("http://localhost/slack/events", { method: "POST", body: "{}", headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=bad" } });
  const whatsappResponse = await app.request("http://localhost/whatsapp/webhook", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=bad" } });
  const sendblueResponse = await app.request("http://localhost/sendblue/webhook", { method: "POST", body: "{}", headers: { "sb-signing-secret": "bad" } });
  assert.equal(slackResponse.status, 401);
  assert.equal(whatsappResponse.status, 401);
  assert.equal(sendblueResponse.status, 401);
});

test("Telegram webhook validation is strict and update parsing is bounded", () => {
  assert.equal(verifyTelegramWebhookSecret("secret", "secret"), true);
  assert.equal(verifyTelegramWebhookSecret("wrong", "secret"), false);
  assert.equal(verifyTelegramWebhookSecret(undefined, "secret"), false);
  assert.equal(verifyTelegramWebhookSecret(undefined, ""), true);
  assert.deepEqual(parseTelegramWebhookUpdate('{"update_id":42,"message":{"text":"hi"}}')?.update_id, 42);
  assert.equal(parseTelegramWebhookUpdate("[]"), undefined);
  assert.equal(parseTelegramWebhookUpdate('{"update_id":1.5}'), undefined);
  assert.equal(parseTelegramWebhookUpdate("not-json"), undefined);
});
