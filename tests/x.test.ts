import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "chat";
import { CHANNEL_CAPABILITIES } from "../src/channels/capabilities.js";
import { extractUnsupportedXDirectMessageMedia, loadXOutboundMedia, normalizeXDirectMessage, resolveXStateConfig, XAdapter, type XRawMessage } from "../src/channels/x.js";

function message(overrides: Record<string, unknown> = {}): Message<XRawMessage> {
  return {
    raw: { kind: "dm", dmEvent: { id: "dm-1", sender_id: "12345", text: "hello" } },
    id: "dm-1",
    threadId: "x:dm:12345",
    text: "hello",
    author: { userId: "12345", userName: "alice", fullName: "Alice", isMe: false },
    attachments: [],
    metadata: { dateSent: new Date("2026-09-27T10:00:00Z"), edited: false },
    ...overrides,
  } as unknown as Message<XRawMessage>;
}

test("regular X DMs normalize to a private X channel event", () => {
  const normalized = normalizeXDirectMessage(message());
  assert.deepEqual(normalized, {
    provider: "x",
    providerEventId: "dm-1",
    providerUserId: "12345",
    providerConversationId: "12345",
    providerThreadId: "x:dm:12345",
    text: "hello",
    attachments: [],
    receivedAt: new Date("2026-09-27T10:00:00Z").getTime(),
    scope: "private",
    displayName: "Alice",
  });
});

test("regular X DM normalization ignores bot echoes and non-DM payloads", () => {
  assert.equal(normalizeXDirectMessage(message({ author: { userId: "1", userName: "bot", isMe: true } })), undefined);
  assert.equal(normalizeXDirectMessage(message({ raw: { kind: "post" } })), undefined);
  assert.equal(normalizeXDirectMessage(message({ raw: { kind: "dm", dmEvent: { id: "dm-2", sender_id: "not-a-user-id" } } })), undefined);
});

test("regular X DM media is detected before SDK normalization and fails closed", () => {
  const body = JSON.stringify({ data: { event_type: "dm.received", payload: { direct_message_events: [{ id: "media-dm", message_create: { message_data: { text: "What is this?", attachment: { type: "photo", media_id: "private-media-id" } } } }] } } });
  const media = extractUnsupportedXDirectMessageMedia(body);
  assert.deepEqual(media, [{ eventId: "media-dm", kind: "image" }]);
  const normalized = normalizeXDirectMessage(message({ id: "media-dm", raw: { kind: "dm", dmEvent: { id: "media-dm", sender_id: "12345" } } }), media[0].kind);
  assert.equal(normalized?.attachments[0].mediaError, "unsupported_media_type");
  assert.equal(extractUnsupportedXDirectMessageMedia("not-json").length, 0);
});

test("X adapter requires webhook verification and a complete OAuth token mode", () => {
  assert.throws(() => new XAdapter({ consumerSecret: "secret", processInbound: async () => undefined }), /X_USER_ACCESS_TOKEN/);
  assert.throws(() => new XAdapter({ userAccessToken: "token", consumerSecret: "", processInbound: async () => undefined }), /X_CONSUMER_SECRET/);
  assert.throws(() => new XAdapter({ clientId: "client", consumerSecret: "secret", processInbound: async () => undefined }), /both X_CLIENT_ID and X_REFRESH_TOKEN/);
  assert.equal(new XAdapter({ userAccessToken: "token", consumerSecret: "secret", processInbound: async () => undefined }).provider, "x");
});

test("X channel uses separate production Redis state and advertises no typing or buttons", () => {
  assert.deepEqual(resolveXStateConfig("redis://localhost:6379", true), { kind: "ioredis", url: "redis://localhost:6379" });
  assert.deepEqual(resolveXStateConfig(undefined, false), { kind: "memory" });
  assert.throws(() => resolveXStateConfig(undefined, true), /requires REDIS_URL/);
  assert.equal(CHANNEL_CAPABILITIES.x.supportsTyping, false);
  assert.equal(CHANNEL_CAPABILITIES.x.supportsButtons, false);
});

test("X outbound images load only from the sender's private R2 namespace", async () => {
  const keys: string[] = [];
  const bytes = Buffer.from("image-bytes");
  const loaded = await loadXOutboundMedia({ id: "x/42/123e4567-e89b-12d3-a456-426614174000.png", kind: "image", mimeType: "image/png" }, 42, async (key) => {
    keys.push(key);
    return bytes;
  });
  assert.deepEqual(loaded, bytes);
  assert.deepEqual(keys, ["x/42/123e4567-e89b-12d3-a456-426614174000.png"]);
  await assert.rejects(() => loadXOutboundMedia({ id: "x/43/private.png", kind: "image" }, 42, async () => bytes), /private R2 namespace/);
  await assert.rejects(() => loadXOutboundMedia({ id: "x/42/../43/private.png", kind: "image" }, 42, async () => bytes), /private R2 namespace/);
  await assert.rejects(() => loadXOutboundMedia({ id: "external-file", kind: "image", url: "https://example.com/image.png" }, 42, async () => bytes), /private R2 namespace/);
});

test("X outbound image bytes reach the official DM uploader", async () => {
  const bytes = Buffer.from("verified-private-image");
  let posted: { markdown: string; files?: Array<{ data: Buffer; filename: string; mimeType?: string }> } | undefined;
  const adapter = new XAdapter({ userAccessToken: "token", consumerSecret: "secret", processInbound: async () => undefined }, async (key) => {
    assert.equal(key, "x/42/123e4567-e89b-12d3-a456-426614174000.png");
    return bytes;
  });
  Object.assign(adapter, {
    official: {
      postMessage: async (_threadId: string, message: typeof posted) => {
        posted = message;
        return { id: "provider-message-1" };
      },
    },
    chat: { initialize: async () => undefined },
  });

  const receipt = await adapter.send({
    accountId: "account_42",
    userId: 42,
    target: { provider: "x", conversationId: "12345", threadId: "x:dm:12345" },
    text: "A caption",
    attachments: [{ id: "x/42/123e4567-e89b-12d3-a456-426614174000.png", kind: "image", filename: "post.png", mimeType: "image/png" }],
    idempotencyKey: "x-image-test",
  });

  assert.equal(posted?.markdown, "A caption");
  assert.equal(posted?.files?.length, 1);
  assert.deepEqual(posted?.files?.[0]?.data, bytes);
  assert.equal(posted?.files?.[0]?.filename, "post.png");
  assert.equal(posted?.files?.[0]?.mimeType, "image/png");
  assert.equal(receipt.providerMessageId, "provider-message-1");
});

test("official X ESM packages load under Chusky's CommonJS build", async () => {
  const [chat, memory, redis, x] = await Promise.all([
    import("chat"),
    import("@chat-adapter/state-memory"),
    import("@chat-adapter/state-ioredis"),
    import("@chat-adapter/x"),
  ]);
  assert.equal(typeof chat.Chat, "function");
  assert.equal(typeof memory.createMemoryState, "function");
  assert.equal(typeof redis.createIoRedisState, "function");
  assert.equal(typeof x.createXAdapter, "function");
});
