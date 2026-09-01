import { createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import { ChannelVerificationError } from "./contracts.js";
import type { ChannelAdapter, ChannelAttachment, ChannelMediaError, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";
import { formatSendblueText } from "./sendblueFormatting.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Verify current timestamped HMAC signatures, with legacy header compatibility. */
export function verifySendblueSignature(rawBody: string | Buffer, headers: Headers | Record<string, string | undefined>, secret: string, maxAgeSeconds = 300): void {
  if (!secret) throw new ChannelVerificationError("Sendblue webhook secret is not configured");
  const get = (name: string) => headers instanceof Headers
    ? (headers.get(name) ?? "")
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
  const header = get("X-Sendblue-Signature");
  if (header) {
    const values = Object.fromEntries(header.split(",").map((part) => {
      const i = part.indexOf("=");
      return i > 0 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : ["", ""];
    }).filter(([key]) => key));
    const timestamp = Number(values.t);
    const signature = String(values.v1 ?? "");
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > maxAgeSeconds || !/^[a-f0-9]{64}$/i.test(signature)) throw new ChannelVerificationError("Invalid or stale Sendblue webhook signature");
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString()}`).digest("hex");
    if (!sameSecret(signature.toLowerCase(), expected)) throw new ChannelVerificationError("Invalid Sendblue webhook signature");
    return;
  }
  const legacy = get("sb-signing-secret");
  if (!sameSecret(legacy, secret)) throw new ChannelVerificationError("Invalid Sendblue webhook signature");
}

function attachment(payload: any): ChannelAttachment[] {
  const mediaUrl = typeof payload?.media_url === "string" ? payload.media_url.trim() : "";
  if (!mediaUrl || !/^https:\/\//i.test(mediaUrl)) return [];
  const kind = String(payload.message_type ?? "").toLowerCase().includes("audio") ? "audio"
    : /\.(mp4|mov|webm)(?:\?|$)/i.test(mediaUrl) ? "video" : "image";
  return [{ id: String(payload.message_handle ?? mediaUrl), kind, url: mediaUrl }];
}

const SEND_BLUE_MEDIA_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
  "audio/webm", "audio/ogg", "audio/aac", "audio/flac",
  "video/mp4", "video/webm",
]);

function kindForMimeType(mimeType: string): ChannelAttachment["kind"] {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "image";
}

function mediaErrorFor(error: unknown): ChannelMediaError {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("larger than")) return "too_large";
  if (message.includes("empty")) return "empty_media";
  if (message.includes("Unsupported")) return "unsupported_media_type";
  return "download_failed";
}

const REACTIONS = new Set(["love", "like", "dislike", "laugh", "emphasize", "question"]);

export function normalizeSendblueMessage(payload: any, receivedAt = Date.now()): InboundMessage | undefined {
  if (!payload || payload.is_outbound === true || !payload.message_handle || !payload.from_number) return undefined;
  const groupId = String(payload.group_id ?? "").trim();
  const sender = String(payload.from_number).trim();
  const recipient = String(payload.sendblue_number ?? payload.to_number ?? "").trim();
  if (!sender || !recipient) return undefined;
  return {
    provider: "sendblue",
    providerEventId: String(payload.message_handle),
    providerUserId: sender,
    providerConversationId: groupId || sender,
    ...(groupId ? { providerWorkspaceId: recipient } : {}),
    ...(payload.reply_to?.message_handle ? { providerReplyToId: String(payload.reply_to.message_handle) } : {}),
    text: typeof payload.content === "string" && payload.content.trim() ? payload.content.trim() : undefined,
    attachments: attachment(payload),
    receivedAt,
    scope: groupId ? "shared" : "private",
  };
}

export interface SendblueStatus {
  providerMessageId: string;
  status: string;
}

/** Short-lived Agora credentials returned by Sendblue for an outbound FaceTime call. */
export interface SendblueFaceTimeCall {
  status: string;
  message: string;
  agora: { appId: string; channelName: string; token: string; uid: number };
}

export function normalizeSendblueStatus(payload: any): SendblueStatus | undefined {
  if (!payload?.is_outbound || !payload?.message_handle || !payload?.status) return undefined;
  return { providerMessageId: String(payload.message_handle), status: String(payload.status) };
}

export class SendblueAdapter implements ChannelAdapter {
  readonly provider = "sendblue" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.sendblue;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fromNumber: string,
    private readonly statusCallback?: string,
    fetchImpl: FetchLike = fetch,
  ) { this.fetchImpl = fetchImpl; }

  private headers(): Record<string, string> {
    return { "sb-api-key-id": this.apiKey, "sb-api-secret-key": this.apiSecret, "Content-Type": "application/json" };
  }

  private isGroup(target: OutboundMessage["target"]): boolean {
    return Boolean(target.metadata?.groupId);
  }

  /**
   * Start an outbound FaceTime call on a Sendblue FaceTime-enabled line.
   * The returned Agora token is intentionally short-lived and must be passed
   * directly to a media bridge; callers must never persist or log it.
   */
  async startFaceTimeCall(phoneNumber: string, fromNumber = this.fromNumber): Promise<SendblueFaceTimeCall> {
    if (!this.apiKey || !this.apiSecret || !fromNumber) throw new Error("Sendblue API credentials and FaceTime sending number are required");
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber) || !/^\+[1-9]\d{7,14}$/.test(fromNumber)) throw new Error("FaceTime numbers must be in E.164 format");
    const response = await this.fetchImpl("https://api.sendblue.com/facetime/start-call", {
      method: "POST", headers: this.headers(), body: JSON.stringify({ phoneNumber, fromNumber }), signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => ({})) as any;
    const agora = value?.agora;
    if (!response.ok || value?.status !== "OK" || !agora || typeof agora.appId !== "string" || typeof agora.channelName !== "string" || typeof agora.token !== "string" || !Number.isSafeInteger(agora.uid)) {
      throw new Error(`Sendblue FaceTime call failed: ${String(value?.message ?? value?.error ?? response.statusText).slice(0, 300)}`);
    }
    return { status: "OK", message: String(value.message ?? "Call started"), agora: { appId: agora.appId, channelName: agora.channelName, token: agora.token, uid: agora.uid } };
  }

  async typing(target: OutboundMessage["target"]): Promise<void> {
    if (this.isGroup(target) || !this.apiKey || !this.apiSecret || !this.fromNumber) return;
    const response = await this.fetchImpl("https://api.sendblue.com/api/send-typing-indicator", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ from_number: this.fromNumber, number: target.conversationId, state: "start", max_duration_ms: 300_000 }),
    });
    if (!response.ok) throw new Error(`Sendblue typing indicator failed: ${response.status}`);
  }

  async stopTyping(target: OutboundMessage["target"]): Promise<void> {
    if (this.isGroup(target) || !this.apiKey || !this.apiSecret || !this.fromNumber) return;
    const response = await this.fetchImpl("https://api.sendblue.com/api/send-typing-indicator", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ from_number: this.fromNumber, number: target.conversationId, state: "stop" }),
    });
    if (!response.ok) throw new Error(`Sendblue typing indicator stop failed: ${response.status}`);
  }

  async markRead(target: OutboundMessage["target"]): Promise<void> {
    if (this.isGroup(target) || !this.apiKey || !this.apiSecret || !this.fromNumber) return;
    const response = await this.fetchImpl("https://api.sendblue.com/api/mark-read", { method: "POST", headers: this.headers(), body: JSON.stringify({ number: target.conversationId, from_number: this.fromNumber }) });
    if (!response.ok) throw new Error(`Sendblue mark-read failed: ${response.status}`);
  }

  async react(target: OutboundMessage["target"], messageHandle: string, reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"): Promise<void> {
    if (this.isGroup(target) || !REACTIONS.has(reaction) || !messageHandle || !this.apiKey || !this.apiSecret || !this.fromNumber) return;
    const response = await this.fetchImpl("https://api.sendblue.com/api/send-reaction", { method: "POST", headers: this.headers(), body: JSON.stringify({ from_number: this.fromNumber, message_handle: messageHandle, reaction }) });
    if (!response.ok) throw new Error(`Sendblue reaction failed: ${response.status}`);
  }

  async configureReceiveWebhook(url: string, secret: string): Promise<void> {
    if (!this.apiKey || !this.apiSecret) throw new Error("Sendblue API credentials are required");
    const response = await this.fetchImpl("https://api.sendblue.com/api/account/webhooks", { method: "POST", headers: this.headers(), body: JSON.stringify({ webhooks: [{ url, secret }], type: "receive" }) });
    if (!response.ok) throw new Error(`Sendblue webhook registration failed: ${response.statusText}`);
  }

  async createPhoneVerification(serviceSid: string, phoneNumber: string): Promise<{ verificationId: string; code: string; destinationNumber: string; deepLink?: string }> {
    if (!this.apiKey || !this.apiSecret) throw new Error("Sendblue API credentials are required");
    const response = await this.fetchImpl(`https://api.sendblue.com/api/v2/verify/services/${encodeURIComponent(serviceSid)}/verifications`, { method: "POST", headers: this.headers(), body: JSON.stringify({ to: phoneNumber }) });
    const value = await response.json() as any;
    if (!response.ok || !value.sid || !value.delivery_target?.code || !value.delivery_target?.pool_number) throw new Error(`Sendblue phone verification failed: ${value.error_message ?? response.statusText}`);
    return { verificationId: String(value.sid), code: String(value.delivery_target.code), destinationNumber: String(value.delivery_target.pool_number), deepLink: value.delivery_target.sms_deep_link ? String(value.delivery_target.sms_deep_link) : undefined };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (!this.apiKey || !this.apiSecret || !this.fromNumber) throw new Error("Sendblue API credentials and sending number are required");
    const groupId = message.target.metadata?.groupId;
    const isGroup = Boolean(groupId);
    const body: Record<string, unknown> = {
      from_number: this.fromNumber,
      content: formatSendblueText(message.text ?? "").slice(0, this.capabilities.maxTextLength),
      ...(this.statusCallback ? { status_callback: this.statusCallback } : {}),
      ...(groupId ? { group_id: groupId } : { number: message.target.conversationId }),
      ...(message.target.metadata?.messageHandle ? { reply_to: { message_handle: message.target.metadata.messageHandle } } : {}),
    };
    const mediaUrl = message.attachments?.find((item) => item.url)?.url;
    if (mediaUrl) {
      if (!/^https:\/\//i.test(mediaUrl)) throw new Error("Sendblue outbound media must be hosted at an HTTPS URL");
      body.media_url = mediaUrl;
    }
    const response = await this.fetchImpl(`https://api.sendblue.com/api/${isGroup ? "send-group-message" : "send-message"}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const value = await response.json() as any;
    if (!response.ok || value.error_message || value.error) throw new Error(`Sendblue message failed: ${value.error_message ?? value.error ?? response.statusText}`);
    return { providerMessageId: value.message_handle ? String(value.message_handle) : undefined, deliveredAt: Date.now() };
  }

  /** Download Sendblue CDN media into the bounded format consumed by the agent handler. */
  async hydrateInbound(message: InboundMessage): Promise<InboundMessage> {
    if (!message.attachments.length) return message;
    const attachments: ChannelAttachment[] = [];
    for (const item of message.attachments.slice(0, 5)) {
      if (!item.url) continue;
      try {
        const response = await this.fetchImpl(item.url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Sendblue media download failed: ${response.status}`);
        const mimeType = String(response.headers.get("content-type") ?? item.mimeType ?? "application/octet-stream").split(";", 1)[0].toLowerCase();
        if (!SEND_BLUE_MEDIA_TYPES.has(mimeType)) throw new Error(`Unsupported Sendblue media type: ${mimeType}`);
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > 12 * 1024 * 1024) throw new Error("Sendblue media is larger than 12 MB");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 1 || bytes.length > 12 * 1024 * 1024) throw new Error("Sendblue media is empty or larger than 12 MB");
        attachments.push({ ...item, kind: kindForMimeType(mimeType), mimeType, sizeBytes: bytes.length, url: `data:${mimeType};base64,${bytes.toString("base64")}` });
      } catch (error) {
        // The webhook itself is valid. Preserve a safe marker so the handler
        // can acknowledge the sender rather than endlessly retrying media.
        attachments.push({ ...item, mediaError: mediaErrorFor(error) });
      }
    }
    return { ...message, attachments };
  }
}
