import { createHash } from "node:crypto";
import { enqueueChannelDebounce, takeChannelDebounce } from "../store.js";
import type { InboundMessage } from "./contracts.js";

export function debounceKey(message: Pick<InboundMessage, "provider" | "providerUserId" | "providerWorkspaceId">): string {
  return createHash("sha256").update(`${message.provider}:${message.providerWorkspaceId ?? "-"}:${message.providerUserId}`).digest("hex");
}

/**
 * Merges short WhatsApp bursts before invoking the agent. The queue is stored
 * in Redis, so timers on multiple replicas race safely: only one replica can
 * drain the list. A new message recreates the timer after a process restart.
 */
export class ChannelDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly waitMs = 900) {}

  async push(message: InboundMessage, flush: (message: InboundMessage) => Promise<void>): Promise<void> {
    const key = debounceKey(message);
    await enqueueChannelDebounce(key, message, Math.ceil((this.waitMs + 10_000) / 1000));
    const current = this.timers.get(key);
    if (current) clearTimeout(current);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.flush(key, flush);
    }, this.waitMs));
  }

  private async flush(key: string, callback: (message: InboundMessage) => Promise<void>): Promise<void> {
    const messages = await takeChannelDebounce(key);
    if (!messages.length) return;
    const first = messages[0];
    const last = messages[messages.length - 1];
    const text = messages.map((message) => message.text?.trim()).filter(Boolean).join("\n");
    await callback({
      ...first,
      providerEventId: `debounce:${first.providerEventId}:${last.providerEventId}`,
      text: text || undefined,
      attachments: messages.flatMap((message) => message.attachments).slice(0, 5),
      receivedAt: last.receivedAt,
    });
  }
}

