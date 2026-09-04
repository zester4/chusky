import { createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import { ChannelVerificationError } from "./contracts.js";
import type { ChannelAdapter, ChannelAttachment, ChannelTemplate, DeliveryReceipt, InboundMessage, OutboundMessage } from "./contracts.js";
import { formatWhatsAppText } from "./whatsappFormatting.js";
import { readR2Object } from "../lib/storage/r2.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type MediaLoader = (key: string) => Promise<Buffer>;

function header(headers: Headers | Record<string, string | undefined>, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? "";
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
}

export function verifyWhatsAppSignature(rawBody: string | Buffer, headers: Headers | Record<string, string | undefined>, appSecret: string): void {
  if (!appSecret) throw new ChannelVerificationError("WhatsApp app secret is not configured");
  const signature = header(headers, "x-hub-signature-256");
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody.toString()).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new ChannelVerificationError("Invalid WhatsApp webhook signature");
}

function mediaAttachment(message: any): ChannelAttachment[] {
  const mediaKind = ["image", "audio", "video", "document"].find((kind) => message[kind]);
  if (!mediaKind) return [];
  const media = message[mediaKind];
  return [{ id: String(media.id ?? `${message.id}:${mediaKind}`), kind: mediaKind as ChannelAttachment["kind"], mimeType: media.mime_type ? String(media.mime_type) : undefined, filename: media.filename ? String(media.filename).slice(0, 200) : undefined }];
}

export function normalizeWhatsAppMessages(payload: any, receivedAt = Date.now()): InboundMessage[] {
  const messages: InboundMessage[] = [];
  if (!payload || payload.object !== "whatsapp_business_account") return [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        if (!message?.id || !message.from) continue;
        const buttonReply = message.type === "interactive" ? message.interactive?.button_reply : undefined;
        const text = message.type === "text" ? String(message.text?.body ?? "").trim() : buttonReply?.title ? String(buttonReply.title).trim() : undefined;
        messages.push({
        provider: "whatsapp",
        providerEventId: String(message.id),
        providerUserId: String(message.from),
        providerWorkspaceId: String(value.metadata?.phone_number_id ?? entry.id ?? ""),
        providerConversationId: String(message.from),
        text: text || undefined,
        attachments: mediaAttachment(message),
        ...(buttonReply?.id ? { interaction: { kind: String(buttonReply.id).startsWith("chusky_approval_") ? "approval" as const : "button" as const, id: String(buttonReply.id).split(":")[0], value: String(buttonReply.id).split(":")[1] } } : {}),
        receivedAt,
        scope: "private",
        displayName: Array.isArray(value.contacts) && value.contacts[0]?.profile?.name ? String(value.contacts[0].profile.name).slice(0, 200) : undefined,
        });
      }
    }
  }
  return messages;
}

export function normalizeWhatsAppPayload(payload: any, receivedAt = Date.now()): InboundMessage | undefined {
  return normalizeWhatsAppMessages(payload, receivedAt)[0];
}

export interface WhatsAppDeliveryStatus {
  providerMessageId: string;
  status: string;
  recipientId?: string;
  timestamp?: number;
}

export function normalizeWhatsAppStatuses(payload: any): WhatsAppDeliveryStatus[] {
  const statuses: WhatsAppDeliveryStatus[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      for (const status of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
        if (!status?.id || !status?.status) continue;
        statuses.push({ providerMessageId: String(status.id), status: String(status.status), recipientId: status.recipient_id ? String(status.recipient_id) : undefined, timestamp: status.timestamp ? Number(status.timestamp) * 1000 : undefined });
      }
    }
  }
  return statuses;
}

export function verifyWhatsAppChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined, configuredToken: string): string {
  if (mode !== "subscribe" || !challenge || !configuredToken || token !== configuredToken) throw new ChannelVerificationError("Invalid WhatsApp webhook verification", 403);
  return challenge;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly provider = "whatsapp" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.whatsapp;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly accessToken: string, private readonly phoneNumberId: string, private readonly graphVersion = "v23.0", fetchImpl: FetchLike = fetch, private readonly mediaLoader: MediaLoader = readR2Object) {
    this.fetchImpl = fetchImpl;
  }

  private async providerMediaId(attachment: ChannelAttachment): Promise<string | undefined> {
    if (!attachment.id.startsWith("whatsapp/")) return undefined;
    const bytes = await this.mediaLoader(attachment.id);
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("WhatsApp outbound media is empty or too large");
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([bytes], { type: attachment.mimeType || "application/octet-stream" }), attachment.filename || `chusky.${attachment.mimeType?.split("/")[1] || "bin"}`);
    const response = await this.fetchImpl(`https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${this.accessToken}` }, body: form });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok || !value.id) throw new Error(`WhatsApp media upload failed: ${value.error?.message ?? response.statusText}`);
    return String(value.id);
  }

  private templateBody(template: ChannelTemplate): Record<string, unknown> {
    if (!/^[a-z0-9_]{1,512}$/.test(template.name)) throw new Error("WhatsApp template name must contain only lowercase letters, numbers, and underscores");
    if (!/^[A-Za-z0-9_-]{1,35}$/.test(template.languageCode)) throw new Error("WhatsApp template language code is invalid");
    if (template.components !== undefined) {
      if (!Array.isArray(template.components) || template.components.length > 10 || template.components.some((component) => !component || Array.isArray(component) || typeof component !== "object")) {
        throw new Error("WhatsApp template components are invalid");
      }
      if (JSON.stringify(template.components).length > 16_384) throw new Error("WhatsApp template components are too large");
    }
    return {
      name: template.name,
      language: { code: template.languageCode },
      ...(template.components?.length ? { components: template.components } : {}),
    };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (!this.accessToken || !this.phoneNumberId) throw new Error("WhatsApp access token and phone number ID are required");
    if (message.template && message.interactive) throw new Error("WhatsApp template cannot be combined with interactive message");
    if (message.attachments?.length && (message.template || message.interactive)) throw new Error("WhatsApp interactive or template messages cannot include media");
    const send = async (body: Record<string, unknown>): Promise<string | undefined> => {
      const response = await this.fetchImpl(`https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as any;
      if (!response.ok || value.error) throw new Error(`WhatsApp message failed: ${value.error?.message ?? response.statusText}`);
      return Array.isArray(value.messages) ? String(value.messages[0]?.id ?? "") : undefined;
    };
    const body = message.template ? {
      messaging_product: "whatsapp", recipient_type: "individual", to: message.target.conversationId, type: "template",
      template: this.templateBody(message.template),
    } : message.interactive ? {
      messaging_product: "whatsapp", recipient_type: "individual", to: message.target.conversationId, type: "interactive",
      interactive: { type: "button", body: { text: message.interactive.body.slice(0, 1024) }, action: { buttons: message.interactive.buttons.slice(0, 3).map((button) => ({ type: "reply", reply: { id: button.id.slice(0, 256), title: button.title.slice(0, 20) } })) } },
    } : { messaging_product: "whatsapp", recipient_type: "individual", to: message.target.conversationId, type: "text", text: { preview_url: false, body: formatWhatsAppText(message.text ?? "") } };
    let lastMessageId: string | undefined;
    if (!message.attachments?.length || message.text?.trim()) lastMessageId = await send(body);
    for (const attachment of (message.attachments ?? []).slice(0, 10)) {
      const mediaId = await this.providerMediaId(attachment);
      const media = mediaId ? { id: mediaId } : { link: attachment.url };
      if (!attachment.url && !mediaId) throw new Error("WhatsApp outbound media requires an HTTPS URL");
      const type = attachment.kind;
      lastMessageId = await send({ messaging_product: "whatsapp", recipient_type: "individual", to: message.target.conversationId, type, [type]: media });
    }
    return { providerMessageId: lastMessageId, deliveredAt: Date.now() };
  }

  /** Resolve a provider media ID into a bounded data URL for the agent. */
  async hydrateInbound(message: InboundMessage): Promise<InboundMessage> {
    if (!message.attachments.length) return message;
    const attachments = [];
    for (const attachment of message.attachments.slice(0, 5)) {
      const metadataResponse = await this.fetchImpl(`https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(attachment.id)}`, { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(10_000) });
      if (!metadataResponse.ok) throw new Error(`WhatsApp media metadata failed: ${metadataResponse.status}`);
      const metadata = await metadataResponse.json() as any;
      const mimeType = String(metadata.mime_type ?? attachment.mimeType ?? "application/octet-stream").toLowerCase();
      const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "video/mp4", "video/webm", "application/pdf", "text/plain", "text/markdown"]);
      if (!allowed.has(mimeType)) throw new Error(`Unsupported WhatsApp media type: ${mimeType}`);
      const url = String(metadata.url ?? "");
      if (!url) throw new Error("WhatsApp media metadata did not include a download URL");
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`WhatsApp media download failed: ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > 12 * 1024 * 1024) throw new Error("WhatsApp media is larger than 12 MB");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1 || bytes.length > 12 * 1024 * 1024) throw new Error("WhatsApp media is empty or larger than 12 MB");
      attachments.push({ ...attachment, mimeType, url: `data:${mimeType};base64,${bytes.toString("base64")}` });
    }
    return { ...message, attachments };
  }
}
