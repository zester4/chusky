import twilio from "twilio";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import { ChannelVerificationError } from "./contracts.js";
import type { ChannelAdapter, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";

/** Optional SMS boundary. It is provider-neutral; a Twilio-compatible sender can be injected. */
export class SmsAdapter implements ChannelAdapter {
  readonly provider = "sms" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.sms;

  constructor(private readonly sendSms: (to: string, text: string, idempotencyKey: string) => Promise<{ providerMessageId?: string }>) {}

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const result = await this.sendSms(message.target.conversationId, (message.text ?? "").slice(0, this.capabilities.maxTextLength), message.idempotencyKey);
    return { providerMessageId: result.providerMessageId, deliveredAt: Date.now() };
  }
}

export interface TwilioSmsAdapterOptions {
  accountSid: string;
  authToken: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
  statusCallbackUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Twilio Messaging API adapter for SMS/MMS, following the provider-neutral channel contract. */
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly provider = "sms" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.sms;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TwilioSmsAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!options.accountSid || !options.authToken) throw new Error("Twilio SMS requires an account SID and auth token");
    if (!options.phoneNumber && !options.messagingServiceSid) throw new Error("Twilio SMS requires a phone number or messaging service SID");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const body = new URLSearchParams();
    body.set("To", message.target.conversationId);
    if (this.options.messagingServiceSid) body.set("MessagingServiceSid", this.options.messagingServiceSid);
    else body.set("From", this.options.phoneNumber!);
    if (message.text) body.set("Body", message.text.slice(0, this.capabilities.maxTextLength));
    for (const attachment of message.attachments ?? []) if (attachment.url?.startsWith("https://")) body.append("MediaUrl", attachment.url);
    if (this.options.statusCallbackUrl) body.set("StatusCallback", this.options.statusCallbackUrl);
    const response = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": message.idempotencyKey,
      },
      body,
    });
    const payload = await response.json().catch(() => ({})) as { sid?: string; message?: string; code?: number };
    if (!response.ok || !payload.sid) throw new Error(`Twilio SMS send failed: ${payload.message ?? response.statusText}`);
    return { providerMessageId: payload.sid, deliveredAt: Date.now() };
  }

  async hydrateInbound(message: InboundMessage): Promise<InboundMessage> {
    const attachments = await Promise.all(message.attachments.slice(0, 10).map(async (attachment) => {
      if (!attachment.url || attachment.url.startsWith("data:")) return attachment;
      try {
        const response = await this.fetchImpl(attachment.url, {
          headers: { Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}` },
        });
        if (!response.ok) return { ...attachment, mediaError: "download_failed" as const };
        const bytes = Buffer.from(await response.arrayBuffer());
        const limit = attachment.mimeType?.startsWith("image/") ? 5 * 1024 * 1024 : 500 * 1024;
        if (!bytes.length) return { ...attachment, mediaError: "empty_media" as const };
        if (bytes.length > limit) return { ...attachment, mediaError: "too_large" as const };
        return { ...attachment, sizeBytes: bytes.length, url: `data:${attachment.mimeType || "application/octet-stream"};base64,${bytes.toString("base64")}` };
      } catch {
        return { ...attachment, mediaError: "download_failed" as const };
      }
    }));
    return { ...message, attachments };
  }
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): void {
  if (!authToken || !signature || !twilio.validateRequest(authToken, signature, url, params)) throw new ChannelVerificationError("Invalid Twilio webhook signature");
}

function attachmentKind(contentType: string): "image" | "audio" | "video" | "document" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

export function normalizeTwilioMessage(input: Record<string, string>, receivedAt = Date.now()): InboundMessage | undefined {
  const messageId = String(input.MessageSid ?? "").trim();
  const from = String(input.From ?? "").trim();
  if (!messageId || !from) return undefined;
  const count = Math.min(10, Math.max(0, Number(input.NumMedia ?? 0) || 0));
  const attachments = Array.from({ length: count }, (_, index) => {
    const url = String(input[`MediaUrl${index}`] ?? "").trim();
    const mimeType = String(input[`MediaContentType${index}`] ?? "").trim() || undefined;
    return { id: `${messageId}:${index}`, kind: attachmentKind(mimeType ?? "application/octet-stream"), mimeType, url };
  }).filter((item) => item.url);
  return { provider: "sms", providerEventId: messageId, providerUserId: from, providerConversationId: from, text: String(input.Body ?? "").trim() || undefined, attachments, receivedAt, scope: "private", displayName: String(input.FromCity ?? "").trim() || undefined };
}

export function normalizeSmsMessage(input: { messageId: string; from: string; body?: string; receivedAt?: number }): InboundMessage {
  return { provider: "sms", providerEventId: input.messageId, providerUserId: input.from, providerConversationId: input.from, text: input.body?.trim() || undefined, attachments: [], receivedAt: input.receivedAt ?? Date.now(), scope: "private" };
}
