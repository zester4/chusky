import type { OutboundMessage } from "../channels/contracts.js";
import type { ReminderDeliveryTarget } from "../store.js";
import { mdToTelegramHtml, splitHtml } from "../markdown.js";

export async function deliverSubagentResult(input: {
  userId: number;
  handoffId: string;
  workflowRunId?: string;
  title: string;
  output: string;
  target?: ReminderDeliveryTarget;
  telegramChatId?: number;
  send: (message: OutboundMessage) => Promise<unknown>;
}): Promise<void> {
  if (!input.output.trim()) return;
  const runKey = input.workflowRunId ?? "resume";
  const text = `${input.title}\n\n${input.output}`;
  if (input.target) {
    await input.send({
      accountId: `account_${input.userId}`,
      userId: input.userId,
      target: input.target,
      text: text.slice(0, 12_000),
      idempotencyKey: `subagent:${input.handoffId}:${runKey}:${input.target.provider}`,
      correlationId: input.handoffId,
      kind: "notification",
    });
    return;
  }
  if (!input.telegramChatId) return;
  const target = { provider: "telegram" as const, conversationId: String(input.telegramChatId) };
  for (const [index, chunk] of splitHtml(mdToTelegramHtml(text), 3900).entries()) {
    await input.send({
      accountId: `account_${input.userId}`,
      userId: input.userId,
      target,
      text: chunk,
      idempotencyKey: `subagent:${input.handoffId}:${runKey}:telegram:${input.telegramChatId}:${index}`,
      correlationId: input.handoffId,
      kind: "notification",
    });
  }
}
