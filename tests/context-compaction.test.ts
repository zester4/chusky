import test from "node:test";
import assert from "node:assert/strict";
import { compactModelMessages } from "../src/agentContext.js";
import type { ApiMessage } from "../src/types.js";

test("model context compaction keeps system prompts and a complete recent tool exchange", () => {
  const messages: ApiMessage[] = [
    { role: "system", content: "system kernel" },
    { role: "user", content: "original request" },
    { role: "assistant", content: "I am checking the first requirement." },
    { role: "user", content: "Also preserve the verified details." },
    { role: "assistant", content: "I will inspect the account", tool_calls: [{ id: "call_old", type: "function", function: { name: "CHUCK_OLD", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_old", content: "old result" },
    { role: "assistant", content: "The current account needs review", tool_calls: [{ id: "call_recent", type: "function", function: { name: "CHUCK_RECENT", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_recent", content: "x".repeat(12_000) },
    { role: "assistant", content: "The verified result is ready." },
  ];

  const compacted = compactModelMessages(messages, 6);
  assert.equal(compacted[0]?.role, "system");
  assert.ok(compacted.some((message) => message.role === "system" && String(message.content).includes("compacted")));
  const recentCall = compacted.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_recent");
  const recentResult = compacted.find((message) => message.role === "tool" && message.tool_call_id === "call_recent");
  assert.ok(recentCall);
  assert.ok(recentResult);
  assert.ok(String(recentResult?.content).includes("tool output compacted"));
  assert.ok(String(recentResult?.content).length < 9_000);
});

test("small model contexts remain unchanged apart from no-op copying", () => {
  const messages: ApiMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  assert.deepEqual(compactModelMessages(messages), messages);
});
