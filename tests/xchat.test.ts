import test from "node:test";
import assert from "node:assert/strict";
import { XchatAdapter } from "../src/channels/xchat.js";

test("XChat adapter is opt-in and exposes normalized gateway capabilities", () => {
  const adapter = new XchatAdapter({ accessToken: "test-token", consumerSecret: "test-secret", processInbound: async () => undefined });
  assert.equal(adapter.provider, "xchat");
  assert.equal(adapter.capabilities.supportsFiles, true);
  assert.equal(adapter.capabilities.supportsButtons, false);
  assert.equal(adapter.cryptoStatus, "uninitialized");
});

test("official XChat ESM packages load under Chusky's CommonJS build", async () => {
  const [chat, memory, xchat] = await Promise.all([
    import("chat"),
    import("@chat-adapter/state-memory"),
    import("@chat-adapter/x/chat"),
  ]);
  assert.equal(typeof chat.Chat, "function");
  assert.equal(typeof memory.createMemoryState, "function");
  assert.equal(typeof xchat.createXchatAdapter, "function");
});
