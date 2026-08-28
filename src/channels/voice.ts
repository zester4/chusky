import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";

/** Voice is intentionally a transport boundary: STT/TTS providers stay outside the agent core. */
export class VoiceAdapter implements ChannelAdapter {
  readonly provider = "voice" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.voice;

  constructor(private readonly speak: (to: string, text: string, idempotencyKey: string) => Promise<{ providerMessageId?: string }>) {}

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const result = await this.speak(message.target.conversationId, message.text ?? "", message.idempotencyKey);
    return { providerMessageId: result.providerMessageId, deliveredAt: Date.now() };
  }
}

export function normalizeVoiceTranscript(input: { callId: string; callerId: string; transcript: string; receivedAt?: number }): InboundMessage {
  return { provider: "voice", providerEventId: input.callId, providerUserId: input.callerId, providerConversationId: input.callId, text: input.transcript.trim() || undefined, attachments: [], receivedAt: input.receivedAt ?? Date.now(), scope: "private" };
}

