import test from "node:test";
import assert from "node:assert/strict";
import { resolveXchatStateConfig, XchatAdapter } from "../src/channels/xchat.js";

test("XChat adapter is opt-in and exposes normalized gateway capabilities", () => {
  const adapter = new XchatAdapter({ accessToken: "test-token", consumerSecret: "test-secret", processInbound: async () => undefined });
  assert.equal(adapter.provider, "xchat");
  assert.equal(adapter.capabilities.supportsFiles, true);
  assert.equal(adapter.capabilities.supportsButtons, false);
  assert.equal(adapter.cryptoStatus, "uninitialized");
});

test("XChat uses the production ioredis state adapter and refuses memory state in production", () => {
  assert.deepEqual(resolveXchatStateConfig("redis://localhost:6379", true), { kind: "ioredis", url: "redis://localhost:6379" });
  assert.deepEqual(resolveXchatStateConfig(undefined, false), { kind: "memory" });
  assert.throws(() => resolveXchatStateConfig(undefined, true), /requires REDIS_URL/);
});

test("official XChat ESM packages and production Redis state load under Chusky's CommonJS build", async () => {
  const [chat, memory, redis, xchat] = await Promise.all([
    import("chat"),
    import("@chat-adapter/state-memory"),
    import("@chat-adapter/state-ioredis"),
    import("@chat-adapter/x/chat"),
  ]);
  assert.equal(typeof chat.Chat, "function");
  assert.equal(typeof memory.createMemoryState, "function");
  assert.equal(typeof redis.createIoRedisState, "function");
  assert.equal(typeof xchat.createXchatAdapter, "function");
});
