import type { Chat, Message } from "chat";
import { readR2Object } from "../lib/storage/r2.js";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, ChannelAttachment, DeliveryReceipt, InboundMessage, OutboundMessage, ReplyTarget } from "./contracts.js";

type XOfficialAdapter = any;
export type XRawMessage = {
  kind: "dm" | "post";
  dmEvent?: {
    id: string;
    sender_id?: string;
    recipient_id?: string;
    created_at?: string;
    created_timestamp?: string;
  };
};
type XStateConfig = { kind: "ioredis"; url: string } | { kind: "memory" };

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const MAX_OUTBOUND_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_OUTBOUND_MEDIA_FILES = 4;
const MAX_WEBHOOK_INSPECTION_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_MEDIA_EVENTS = 2_000;

type XMediaLoader = (key: string) => Promise<Buffer>;

export interface XAdapterOptions {
  consumerSecret: string;
  userAccessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  encryptionKey?: string;
  userName?: string;
  apiBaseUrl?: string;
  redisUrl?: string;
  processInbound: (message: InboundMessage) => Promise<unknown>;
}

export interface XSetupStatus {
  status: "ready" | "misconfigured";
  botUserId?: string;
  botUsername?: string;
  error?: string;
}

export function resolveXStateConfig(redisUrl: string | undefined, production = process.env.NODE_ENV === "production"): XStateConfig {
  const url = redisUrl?.trim();
  if (url) return { kind: "ioredis", url };
  if (production) throw new Error("X requires REDIS_URL in production; refusing in-memory Chat SDK state");
  return { kind: "memory" };
}

async function boundedRequestText(request: Request): Promise<string | undefined> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_INSPECTION_BYTES) return undefined;
  const reader = request.clone().body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_INSPECTION_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

function mediaKindFromPayload(value: unknown): ChannelAttachment["kind"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const media = (record.media && typeof record.media === "object" ? record.media : record) as Record<string, unknown>;
  const kind = String(media.type ?? record.type ?? "").toLowerCase();
  if (/video|gif/.test(kind)) return "video";
  if (/audio|voice/.test(kind)) return "audio";
  if (/image|photo|media/.test(kind) || "media_id" in media || "media_key" in media) return "image";
  return undefined;
}

/** Identify attachment-bearing inbound X DM events before the official adapter normalizes them. */
export function extractUnsupportedXDirectMessageMedia(body: string): Array<{ eventId: string; kind: ChannelAttachment["kind"] }> {
  let envelope: unknown;
  try { envelope = JSON.parse(body); } catch { return []; }
  if (!envelope || typeof envelope !== "object") return [];
  const data = (envelope as Record<string, unknown>).data;
  const events = Array.isArray(data) ? data : data ? [data] : [];
  const found: Array<{ eventId: string; kind: ChannelAttachment["kind"] }> = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const item = event as Record<string, unknown>;
    if (item.event_type !== "dm.received") continue;
    const payload = item.payload;
    if (!payload || typeof payload !== "object") continue;
    const wireEvents = (payload as Record<string, unknown>).direct_message_events;
    if (!Array.isArray(wireEvents)) continue;
    for (const wire of wireEvents) {
      if (!wire || typeof wire !== "object") continue;
      const wireRecord = wire as Record<string, unknown>;
      const eventId = String(wireRecord.id ?? "").trim();
      const create = wireRecord.message_create;
      if (!eventId || !create || typeof create !== "object") continue;
      const messageData = (create as Record<string, unknown>).message_data;
      if (!messageData || typeof messageData !== "object") continue;
      const content = messageData as Record<string, unknown>;
      const candidates = [content.attachment, content.attachments, (content.entities as Record<string, unknown> | undefined)?.media];
      for (const candidate of candidates) {
        const entries = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
        const kind = entries.map(mediaKindFromPayload).find((value) => value);
        if (kind) { found.push({ eventId, kind }); break; }
      }
    }
  }
  return found;
}

function parseDataUrl(value: string): Buffer | undefined {
  const match = value.match(/^data:([^;,]+);base64,([a-z\d+/=\s]+)$/i);
  if (!match) return undefined;
  return Buffer.from(match[2].replace(/\s/g, ""), "base64");
}

export async function loadXOutboundMedia(attachment: ChannelAttachment, userId: number, loadMedia: XMediaLoader = readR2Object): Promise<Buffer> {
  if (attachment.url?.startsWith("data:")) {
    if (attachment.url.length > Math.ceil(MAX_OUTBOUND_MEDIA_BYTES * 4 / 3) + 256) throw new Error("X media attachment exceeds the 15 MB limit");
    const bytes = parseDataUrl(attachment.url);
    if (!bytes?.length) throw new Error("X media attachment has invalid image data");
    if (bytes.length > MAX_OUTBOUND_MEDIA_BYTES) throw new Error("X media attachment exceeds the 15 MB limit");
    return bytes;
  }
  const key = attachment.id;
  if (!key.startsWith(`x/${userId}/`) || key.split("/").length !== 3 || key.split("/").some((part) => part === ".." || part === ".") || !/^x\/\d+\/[a-f\d-]+\.[a-z\d]+$/i.test(key)) {
    throw new Error("X outbound media must reference a verified file in the sender's private R2 namespace");
  }
  const bytes = await loadMedia(key);
  if (!bytes.length) throw new Error("X media attachment is empty");
  if (bytes.length > MAX_OUTBOUND_MEDIA_BYTES) throw new Error("X media attachment exceeds the 15 MB limit");
  return bytes;
}

/**
 * Regular, unencrypted X Direct Messages through the official Chat SDK adapter.
 * Account identity, message history, idempotency, and delivery remain owned by
 * Chusky's provider-neutral channel gateway.
 */
export class XAdapter implements ChannelAdapter {
  readonly provider = "x" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.x;
  private official?: XOfficialAdapter;
  private chat?: Chat;
  private initialized?: Promise<void>;
  private readonly unsupportedMediaEvents = new Map<string, { kind: ChannelAttachment["kind"]; expiresAt: number }>();

  constructor(private readonly options: XAdapterOptions, private readonly loadMedia: XMediaLoader = readR2Object) {
    const hasStaticToken = Boolean(options.userAccessToken?.trim());
    const hasManagedRefresh = Boolean(options.clientId?.trim() && options.refreshToken?.trim());
    if (!options.consumerSecret.trim()) throw new Error("X requires X_CONSUMER_SECRET for webhook verification");
    if (!hasStaticToken && !hasManagedRefresh) throw new Error("X requires X_USER_ACCESS_TOKEN or both X_CLIENT_ID and X_REFRESH_TOKEN");
    if (Boolean(options.clientId?.trim()) !== Boolean(options.refreshToken?.trim())) throw new Error("X managed refresh requires both X_CLIENT_ID and X_REFRESH_TOKEN");
    if (hasManagedRefresh && process.env.NODE_ENV === "production" && !options.encryptionKey?.trim()) {
      throw new Error("X managed refresh requires X_ENCRYPTION_KEY in production to encrypt persisted OAuth tokens");
    }
  }

  private async load(): Promise<void> {
    if (this.official && this.chat) return;
    const stateConfig = resolveXStateConfig(this.options.redisUrl);
    const [chatModule, stateModule, xModule] = await Promise.all([
      nativeImport("chat"),
      nativeImport(stateConfig.kind === "ioredis" ? "@chat-adapter/state-ioredis" : "@chat-adapter/state-memory"),
      nativeImport("@chat-adapter/x"),
    ]);
    this.official = xModule.createXAdapter({
      consumerSecret: this.options.consumerSecret,
      userAccessToken: this.options.userAccessToken || undefined,
      clientId: this.options.clientId || undefined,
      clientSecret: this.options.clientSecret || undefined,
      refreshToken: this.options.refreshToken || undefined,
      encryptionKey: this.options.encryptionKey || undefined,
      userName: this.options.userName || undefined,
      apiBaseUrl: this.options.apiBaseUrl || undefined,
    });
    this.chat = new chatModule.Chat({
      userName: this.options.userName || "chusky",
      adapters: { x: this.official },
      state: stateConfig.kind === "ioredis"
        ? stateModule.createIoRedisState({ url: stateConfig.url, keyPrefix: "chuck:x" })
        : stateModule.createMemoryState(),
    });
    this.chat!.onDirectMessage(async (_thread: unknown, message) => {
      await this.dispatch(message as Message<XRawMessage>);
    });
  }

  private async ready(): Promise<{ official: XOfficialAdapter; chat: Chat }> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
    return { official: this.official!, chat: this.chat! };
  }

  async initialize(): Promise<XSetupStatus> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    if (!official.botUserId) throw new Error("X adapter could not resolve the authenticated bot user ID");
    return { status: "ready", botUserId: String(official.botUserId), botUsername: String(official.userName || "") || undefined };
  }

  async handleWebhook(request: Request): Promise<Response> {
    const { chat } = await this.ready();
    if (request.method === "POST") {
      const body = await boundedRequestText(request);
      if (body !== undefined) {
        this.pruneUnsupportedMediaEvents();
        for (const item of extractUnsupportedXDirectMessageMedia(body)) {
          if (!this.unsupportedMediaEvents.has(item.eventId) && this.unsupportedMediaEvents.size >= MAX_PENDING_MEDIA_EVENTS) {
            const oldest = this.unsupportedMediaEvents.keys().next().value;
            if (oldest) this.unsupportedMediaEvents.delete(oldest);
          }
          this.unsupportedMediaEvents.set(item.eventId, { kind: item.kind, expiresAt: Date.now() + 5 * 60_000 });
        }
      }
    }
    return chat.webhooks.x(request);
  }

  private async dispatch(message: Message<XRawMessage>): Promise<void> {
    const pendingMedia = this.unsupportedMediaEvents.get(message.id);
    if (pendingMedia) this.unsupportedMediaEvents.delete(message.id);
    const normalized = normalizeXDirectMessage(message, pendingMedia?.kind);
    if (normalized) await this.options.processInbound(normalized);
  }

  private pruneUnsupportedMediaEvents(): void {
    const now = Date.now();
    for (const [eventId, pending] of this.unsupportedMediaEvents) {
      if (pending.expiresAt <= now) this.unsupportedMediaEvents.delete(eventId);
    }
  }

  private async resolveFile(attachment: ChannelAttachment, userId: number): Promise<{ data: Buffer; filename: string; mimeType?: string }> {
    const data = await loadXOutboundMedia(attachment, userId, this.loadMedia);
    const filename = (attachment.filename || `chusky-${attachment.kind}`).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 120);
    return { data, filename: filename || "chusky-media", mimeType: attachment.mimeType };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    const participantId = message.target.conversationId.trim();
    if (!/^\d+$/.test(participantId)) throw new Error("X DM target must be a numeric X user ID");
    const threadId = message.target.threadId || await official.openDM(participantId);
    if ((message.attachments?.length ?? 0) > MAX_OUTBOUND_MEDIA_FILES) throw new Error("X supports at most four media files in one DM");
    const files = await Promise.all((message.attachments ?? []).map((attachment) => this.resolveFile(attachment, message.userId)));
    const text = (message.text ?? "").slice(0, this.capabilities.maxTextLength);
    const result = await official.postMessage(threadId, { markdown: text, ...(files.length ? { files } : {}) });
    return { providerMessageId: String(result?.id ?? "") || undefined, deliveredAt: Date.now(), metadata: { threadId } };
  }
}

export function normalizeXDirectMessage(message: Message<XRawMessage>, unsupportedMediaKind?: ChannelAttachment["kind"]): InboundMessage | undefined {
  const raw = message.raw;
  if (raw.kind !== "dm" || !raw.dmEvent || message.author.isMe) return undefined;
  const senderId = String(raw.dmEvent.sender_id ?? message.author.userId ?? "").trim();
  const eventId = String(raw.dmEvent.id ?? message.id ?? "").trim();
  if (!senderId || !/^\d+$/.test(senderId) || !eventId) return undefined;
  return {
    provider: "x",
    providerEventId: eventId,
    providerUserId: senderId,
    providerConversationId: senderId,
    providerThreadId: message.threadId,
    text: message.text.trim() || undefined,
    // @chat-adapter/x 4.40.0 does not surface inbound DM media in Message.attachments.
    // Do not infer or fabricate image data from the raw webhook payload.
    attachments: unsupportedMediaKind ? [{ id: `${eventId}:unsupported-media`, kind: unsupportedMediaKind, mediaError: "unsupported_media_type" }] : [],
    receivedAt: message.metadata.dateSent instanceof Date ? message.metadata.dateSent.getTime() : Date.now(),
    scope: "private",
    displayName: message.author.fullName || message.author.userName,
  };
}
