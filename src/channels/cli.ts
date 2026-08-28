import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";

/** The terminal already owns its response stream; this adapter is useful for shared routing/tests. */
export class CliAdapter implements ChannelAdapter {
  readonly provider = "cli" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.cli;

  constructor(private readonly deliver: (message: OutboundMessage) => Promise<{ providerMessageId?: string }>) {}

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const result = await this.deliver(message);
    return { providerMessageId: result.providerMessageId, deliveredAt: Date.now() };
  }
}

export function normalizeCliMessage(input: { requestId: string; userId: string; conversationId?: string; text: string; threadId?: string }): InboundMessage {
  return { provider: "cli", providerEventId: input.requestId, providerUserId: input.userId, providerConversationId: input.conversationId ?? input.userId, providerThreadId: input.threadId, text: input.text.trim() || undefined, attachments: [], receivedAt: Date.now(), scope: "private" };
}

