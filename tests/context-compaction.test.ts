import test from "node:test";
import assert from "node:assert/strict";
import { compactModelMessages, compactModelToolDefinition } from "../src/agentContext.js";
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
  assert.ok(String(recentResult?.content).length < 4_000);
});

test("large retained tool exchanges are bounded without dropping the latest exchange", () => {
  const messages: ApiMessage[] = [
    { role: "system", content: "kernel" },
    { role: "user", content: "Find the latest customer status and prepare the next action." },
    ...Array.from({ length: 5 }, (_, index) => [
      { role: "assistant" as const, content: `Calling provider ${index}`, tool_calls: [{ id: `call_${index}`, type: "function" as const, function: { name: "COMPOSIO_EXECUTE_TOOL", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: `call_${index}`, content: "provider payload ".repeat(2_000) },
    ]).flat(),
  ];
  const compacted = compactModelMessages(messages);
  const chars = compacted.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0), 0);
  assert.ok(chars < 32_000);
  assert.ok(compacted.some((message) => message.role === "tool" && message.tool_call_id === "call_4"));
  assert.ok(compacted.some((message) => message.role === "system" && String(message.content).includes("Full tool results remain available")));
});

test("small model contexts remain unchanged apart from no-op copying", () => {
  const messages: ApiMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  assert.deepEqual(compactModelMessages(messages), messages);
});

test("conversation context is bounded when tool schemas consume the prompt budget", () => {
  const messages: ApiMessage[] = [
    { role: "system", content: "kernel" },
    { role: "user", content: "An older request with important historical context ".repeat(80) },
    { role: "assistant", content: "An older response with a large amount of prose ".repeat(80) },
    { role: "user", content: "Current request: read Gmail and check Calendar." },
  ];

  const compacted = compactModelMessages(messages, 14, 1_500);
  const chars = compacted
    .filter((message) => message.role !== "system")
    .reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0), 0);

  assert.ok(chars <= 1_500);
  assert.ok(compacted.some((message) => String(message.content).includes("Current request: read Gmail")));
  assert.ok(compacted.some((message) => String(message.content).includes("conversation context compacted")));
});

test("model tool compaction preserves the callable contract while trimming verbose prose", () => {
  const tool = {
    type: "function",
    function: {
      name: "COMPOSIO_EXAMPLE_ACTION",
      description: "A".repeat(2_000),
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "B".repeat(1_000) },
          status: { type: "string", enum: ["open", "closed"] },
        },
        required: ["order_id"],
        additionalProperties: false,
        examples: [{ order_id: "example" }],
      },
    },
  };

  const compacted = compactModelToolDefinition(tool);
  assert.equal(compacted.function.name, tool.function.name);
  assert.deepEqual(compacted.function.parameters.required, ["order_id"]);
  assert.deepEqual(compacted.function.parameters.properties.status.enum, ["open", "closed"]);
  assert.equal(compacted.function.parameters.examples, undefined);
  assert.ok(compacted.function.description.length < 700);
  assert.ok(compacted.function.parameters.properties.order_id.description.length < 300);
});
