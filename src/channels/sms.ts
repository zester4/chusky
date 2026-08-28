import { createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import { ChannelVerificationError } from "./contracts.js";
import type { ChannelAdapter, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";

/** Optional SMS boundary. It is provider-neutral; a Twilio-compatible sender can be injected. */
export function verifySmsSignature(rawBody: string, signature: string, secret: string): void {
  if (!secret) throw new ChannelVerificationError("SMS signing secret is not configured");
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new ChannelVerificationError("Invalid SMS signature");
}

export class SmsAdapter implements ChannelAdapter {
  readonly provider = "sms" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.sms;

  constructor(private readonly sendSms: (to: string, text: string, idempotencyKey: string) => Promise<{ providerMessageId?: string }>) {}

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const result = await this.sendSms(message.target.conversationId, (message.text ?? "").slice(0, this.capabilities.maxTextLength), message.idempotencyKey);
    return { providerMessageId: result.providerMessageId, deliveredAt: Date.now() };
  }
}

export function normalizeSmsMessage(input: { messageId: string; from: string; body?: string; receivedAt?: number }): InboundMessage {
  return { provider: "sms", providerEventId: input.messageId, providerUserId: input.from, providerConversationId: input.from, text: input.body?.trim() || undefined, attachments: [], receivedAt: input.receivedAt ?? Date.now(), scope: "private" };
}

