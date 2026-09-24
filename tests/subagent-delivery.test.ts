import test from "node:test";
import assert from "node:assert/strict";
import type { OutboundMessage } from "../src/channels/contracts.js";
import { deliverSubagentResult } from "../src/subagents/delivery.js";

test("durable subagent continuation delivers to its saved channel with a replay-stable key", async () => {
  const sent: OutboundMessage[] = [];
  const send = async (message: OutboundMessage) => { sent.push(message); };
  const input = {
    userId: 719,
    handoffId: "handoff_owned",
    workflowRunId: "worker-resume-2",
    title: "✅ Worker task completed",
    output: "Finished the requested work.",
    target: { provider: "slack" as const, conversationId: "C123", threadId: "T456", workspaceId: "W789" },
    telegramChatId: 1234,
    send,
  };

  await deliverSubagentResult(input);
  await deliverSubagentResult(input);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]?.target, input.target);
  assert.equal(sent[0]?.accountId, "account_719");
  assert.equal(sent[0]?.idempotencyKey, "subagent:handoff_owned:worker-resume-2:slack");
  assert.equal(sent[1]?.idempotencyKey, sent[0]?.idempotencyKey);
});

test("Telegram fallback splits long resumed output and keys each chunk by stable run and index", async () => {
  const sent: OutboundMessage[] = [];
  const send = async (message: OutboundMessage) => { sent.push(message); };
  const input = {
    userId: 720,
    handoffId: "handoff_telegram",
    workflowRunId: "worker-resume-3",
    title: "⚠️ Worker task update",
    output: `${"Long output ".repeat(600)}`,
    telegramChatId: 9876,
    send,
  };

  await deliverSubagentResult(input);
  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => message.target.provider === "telegram" && message.target.conversationId === "9876"));
  assert.deepEqual(sent.map((message) => message.idempotencyKey), sent.map((_, index) => `subagent:handoff_telegram:worker-resume-3:telegram:9876:${index}`));
  assert.ok(sent.every((message) => (message.text?.length ?? 0) <= 3900));
});
