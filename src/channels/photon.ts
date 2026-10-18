import { io } from "socket.io-client";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { acquirePhotonEventConsumerLease, getPhotonEventCursor, savePhotonEventCursor, type PhotonEventConsumerLease } from "../store.js";
import { readR2ObjectBounded, r2Configured } from "../lib/storage/r2.js";
import { decodeMediaDataUrl } from "./imageMedia.js";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, ChannelAttachment, DeliveryReceipt, InboundMessage, OutboundMessage, ReplyTarget } from "./contracts.js";
import { ChannelGateway } from "./gateway.js";

const MAX_PHOTON_MEDIA_BYTES = 12 * 1024 * 1024;

export type PhotonProviderName = "imessage" | "whatsapp" | "telegram" | "sms" | "email";
export type PhotonPlatformName = "imessage" | "whatsapp" | "whatsapp_business" | "telegram" | "sms" | "email";
export type PhotonChannelProvider = "photon_imessage" | "photon_whatsapp" | "photon_telegram" | "photon_sms" | "photon_email";

type PhotonRecord = Record<string, any>;
type PhotonUser = PhotonRecord & { id?: string; kind?: string; handle?: string; platform?: string };
type PhotonSpace = PhotonRecord & { id?: string; kind?: string; platform?: string; participantIds?: string[] };
type PhotonMessage = PhotonRecord & {
  id?: string;
  projectId?: string;
  platform?: PhotonPlatformName | string;
  status?: string;
  createdAt?: string;
  sentBy?: PhotonUser;
  receivedBy?: PhotonUser;
  space?: PhotonSpace;
  content?: PhotonRecord;
  parentMessageId?: string;
};
type PhotonEvent = PhotonRecord & { id?: string; type?: string; data?: PhotonRecord; apiVersion?: string };

/** Structural type for the ESM SDK loaded at runtime. The application remains
 * CommonJS, so importing the package only as a type would break this project's
 * classic Node module resolution. */
export type PhotonApiRuntimeModule = {
  Photon: new (options: Record<string, unknown>) => PhotonApiClient;
};
type PhotonApiClient = { projects: Record<string, (input: any) => Promise<any>> };

interface PhotonEventSocket {
  on(event: string, listener: (...args: any[]) => void): PhotonEventSocket;
  timeout(ms: number): { emit(event: string, payload: unknown, acknowledgement: (...args: any[]) => void): void };
  connect(): PhotonEventSocket;
  disconnect(): PhotonEventSocket;
  io: { engine: { close(): void } };
}

export interface PhotonBridgeStatus {
  enabled: boolean;
  started: boolean;
  providers: PhotonProviderName[];
  cursor?: number;
  apiVersion?: string;
  error?: string;
}

export interface PhotonBridgeOptions {
  gateway: ChannelGateway;
  module?: PhotonApiRuntimeModule;
  socketFactory?: (origin: string, options: Record<string, unknown>) => PhotonEventSocket;
}

function dynamicImport<T>(specifier: string): Promise<T> {
  const importer = new Function("name", "return import(name)") as (name: string) => Promise<T>;
  return importer(specifier);
}

export async function loadPhotonApi(): Promise<PhotonApiRuntimeModule> {
  return dynamicImport<PhotonApiRuntimeModule>("@photon-ai/api");
}

function channelProvider(platform: string | undefined): PhotonChannelProvider | undefined {
  if (platform === "imessage") return "photon_imessage";
  if (platform === "whatsapp" || platform === "whatsapp_business") return "photon_whatsapp";
  if (platform === "telegram") return "photon_telegram";
  if (platform === "sms") return "photon_sms";
  if (platform === "email") return "photon_email";
  return undefined;
}

function configuredProvider(provider: PhotonProviderName): boolean {
  return config.photonProviders.includes(provider);
}

function mediaKind(mimeType: string, voice = false): ChannelAttachment["kind"] {
  if (voice || mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

type PhotonAttachmentReader = (attachmentId: string) => Promise<{ bytes: Buffer; mimeType: string; filename?: string; sizeBytes?: number }>;

async function photonContentToParts(
  content: PhotonRecord,
  readAttachment: PhotonAttachmentReader | undefined,
  depth = 0,
): Promise<{ text: string; attachments: ChannelAttachment[] }> {
  if (!content || depth > 3) return { text: "", attachments: [] };
  const type = String(content.type ?? "");
  if (type === "text") return { text: String(content.text ?? "").trim(), attachments: [] };
  if (type === "group") {
    const items = Array.isArray(content.parts) ? content.parts : Array.isArray(content.items) ? content.items : [];
    const parts = await Promise.all(items.slice(0, 10).map((item: PhotonRecord) => photonContentToParts(item, readAttachment, depth + 1)));
    return {
      text: parts.map((part) => part.text).filter(Boolean).join("\n\n").slice(0, 20_000),
      attachments: parts.flatMap((part) => part.attachments).slice(0, 5),
    };
  }
  if (type !== "attachment" && type !== "voice") return { text: "", attachments: [] };

  const attachmentId = String(content.attachmentId ?? content.id ?? "").trim();
  const declaredMime = String(content.contentType ?? content.mimeType ?? "application/octet-stream").toLowerCase().split(";", 1)[0];
  const declaredSize = Number(content.sizeBytes ?? content.size);
  const attachment: ChannelAttachment = {
    id: attachmentId.slice(0, 300) || `${type}:${Date.now()}`,
    kind: mediaKind(declaredMime, type === "voice"),
    mimeType: declaredMime,
    filename: typeof content.filename === "string" ? content.filename.slice(0, 200) : undefined,
    ...(Number.isFinite(declaredSize) && declaredSize >= 0 ? { sizeBytes: declaredSize } : {}),
  };
  if (declaredSize > MAX_PHOTON_MEDIA_BYTES) return { text: "", attachments: [{ ...attachment, mediaError: "too_large" }] };
  if (!readAttachment || !attachmentId) return { text: "", attachments: [{ ...attachment, mediaError: "download_failed" }] };
  try {
    const downloaded = await readAttachment(attachmentId);
    if (!downloaded.bytes.length) return { text: "", attachments: [{ ...attachment, mediaError: "empty_media" }] };
    if (downloaded.bytes.length > MAX_PHOTON_MEDIA_BYTES) return { text: "", attachments: [{ ...attachment, mediaError: "too_large" }] };
    const mimeType = downloaded.mimeType || declaredMime;
    return {
      text: "",
      attachments: [{
        ...attachment,
        mimeType,
        kind: mediaKind(mimeType, type === "voice"),
        ...(downloaded.filename ? { filename: downloaded.filename.slice(0, 200) } : {}),
        sizeBytes: downloaded.bytes.length,
        url: `data:${mimeType};base64,${downloaded.bytes.toString("base64")}`,
      }],
    };
  } catch {
    return { text: "", attachments: [{ ...attachment, mediaError: "download_failed" }] };
  }
}

/** Convert a Photon 2.0 `message.received` object into Chusky's channel contract. */
export async function normalizePhotonMessage(
  message: PhotonMessage,
  options: { projectId: string; defaultScope: "private" | "shared"; readAttachment?: PhotonAttachmentReader },
): Promise<InboundMessage | undefined> {
  if (!message.id || message.projectId !== options.projectId || message.status !== "received") return undefined;
  const channel = channelProvider(message.platform);
  if (!channel) return undefined;
  const configured = channel === "photon_whatsapp" ? configuredProvider("whatsapp") : configuredProvider(channel.replace("photon_", "") as PhotonProviderName);
  if (!configured || !message.sentBy?.id || message.sentBy.kind !== "human" || !message.receivedBy?.id || message.receivedBy.kind !== "agent" || !message.space?.id) return undefined;
  const parts = await photonContentToParts(message.content ?? {}, options.readAttachment);
  if (!parts.text && !parts.attachments.length) return undefined;
  const scope = String(message.space.kind ?? "").toLowerCase() === "direct" ? "private" : options.defaultScope;
  return {
    provider: channel,
    providerEventId: String(message.id).slice(0, 300),
    providerUserId: String(message.sentBy.id).slice(0, 300),
    providerAgentId: String(message.receivedBy.id).slice(0, 300),
    providerWorkspaceId: options.projectId,
    providerConversationId: String(message.space.id).slice(0, 500),
    providerParticipantIds: Array.isArray(message.space.participantIds) ? message.space.participantIds.map(String).slice(0, 100) : undefined,
    providerReplyToId: typeof message.parentMessageId === "string" ? message.parentMessageId : undefined,
    text: parts.text || undefined,
    attachments: parts.attachments.slice(0, 5),
    receivedAt: normalizeTimestamp(message.createdAt),
    scope,
    displayName: String(message.sentBy.handle ?? "").trim().slice(0, 200) || undefined,
  };
}

export function photonMessageFromEvent(event: PhotonEvent): PhotonMessage | undefined {
  if (event.type !== "message.received" || !event.data || typeof event.data.object !== "object" || !event.data.object) return undefined;
  return event.data.object as PhotonMessage;
}

async function boundedAttachmentBytes(attachment: ChannelAttachment): Promise<Buffer> {
  if (attachment.url?.startsWith("data:")) {
    const decoded = decodeMediaDataUrl(attachment.url);
    if (!decoded) throw new Error("Photon outbound attachment data is invalid");
    if (decoded.bytes.length > MAX_PHOTON_MEDIA_BYTES) throw new Error("Photon outbound attachment is too large");
    return decoded.bytes;
  }
  if (!r2Configured() || !attachment.id || attachment.id.length > 500) throw new Error("Photon outbound attachment is not stored safely");
  return readR2ObjectBounded(attachment.id, MAX_PHOTON_MEDIA_BYTES);
}

function interactiveFallback(message: OutboundMessage): string | undefined {
  if (!message.interactive) return message.text;
  const buttons = message.interactive.buttons.flat().map((button) => `• ${button.title}`).join("\n");
  return [message.text, message.interactive.body, buttons ? `Options:\n${buttons}` : undefined].filter(Boolean).join("\n\n").slice(0, 100_000);
}

function acknowledgePhotonDelivery(socket: PhotonEventSocket, eventId: string): void {
  socket.timeout(5_000).emit("reply", {
    eventId,
    status: 202,
    headers: { "content-type": "text/plain" },
    body: Buffer.from("accepted").toString("base64"),
  }, (error: unknown, result: PhotonRecord) => {
    if (error || !result?.ok) logger.warn({ err: error ?? result?.error, eventId }, "Photon delivery reply outcome was not accepted");
  });
}

export class PhotonAdapter implements ChannelAdapter {
  readonly capabilities;

  constructor(readonly provider: PhotonChannelProvider, private readonly client: PhotonApiClient) {
    this.capabilities = CHANNEL_CAPABILITIES[provider];
  }

  private projectId(target: ReplyTarget): string {
    const projectId = target.metadata?.photonProjectId ?? target.workspaceId ?? config.photonProjectId;
    if (!projectId) throw new Error("Photon target is missing its project ID");
    return projectId;
  }

  private agentId(target: ReplyTarget): string {
    const agentId = target.metadata?.photonAgentId;
    if (!agentId) throw new Error("Photon target is missing the receiving agent user ID from the inbound message");
    return agentId;
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const projectId = this.projectId(message.target);
    const parts: PhotonRecord[] = [];
    const text = interactiveFallback(message);
    if (text?.trim()) parts.push({ type: "text", format: "plain", text: text.slice(0, this.capabilities.maxTextLength) });
    for (const [index, attachment] of (message.attachments ?? []).slice(0, 5).entries()) {
      const bytes = await boundedAttachmentBytes(attachment);
      const mimeType = attachment.mimeType ?? "application/octet-stream";
      const uploaded = await (this.client as any).projects.uploadAttachment({
        path: { id: projectId },
        headers: {
          "idempotency-key": `${message.idempotencyKey}:attachment:${index}`,
          "content-type": mimeType,
          "content-length": String(bytes.length),
        },
        body: new Blob([bytes], { type: mimeType }),
      });
      parts.push({ type: attachment.kind === "audio" ? "voice" : "attachment", attachmentId: String(uploaded.id) });
    }
    if (!parts.length) throw new Error("Photon cannot send an empty message");
    const sent = await (this.client as any).projects.sendMessage({
      path: { id: projectId },
      headers: { "idempotency-key": message.idempotencyKey },
      body: {
        spaceId: message.target.conversationId,
        senderId: this.agentId(message.target),
        ...(message.target.metadata?.photonParentMessageId ? { parentMessageId: message.target.metadata.photonParentMessageId } : {}),
        content: parts.length === 1 ? parts[0] : { type: "group", parts },
      },
    });
    return { providerMessageId: sent?.id ? String(sent.id) : undefined, deliveredAt: Date.now() };
  }

  async typing(target: ReplyTarget): Promise<void> {
    await (this.client as any).projects.setSpaceTyping({ path: { id: this.projectId(target), spaceId: target.conversationId }, body: { senderId: this.agentId(target), typing: true } });
  }

  async stopTyping(target: ReplyTarget): Promise<void> {
    await (this.client as any).projects.setSpaceTyping({ path: { id: this.projectId(target), spaceId: target.conversationId }, body: { senderId: this.agentId(target), typing: false } });
  }
}

export class PhotonBridge {
  private socket?: PhotonEventSocket;
  private stopped = false;
  private cursor = 0;
  private apiVersion?: string;
  private consumerLease?: PhotonEventConsumerLease;
  private leaseRenewal?: NodeJS.Timeout;
  private leaseRetry?: NodeJS.Timeout;
  private readonly adapters = new Map<PhotonChannelProvider, PhotonAdapter>();
  private readonly module?: PhotonApiRuntimeModule;

  constructor(private readonly options: PhotonBridgeOptions) {
    this.module = options.module;
  }

  async start(): Promise<PhotonBridgeStatus> {
    if (!config.photonEnabled) return { enabled: false, started: false, providers: [] };
    if (!config.photonProjectId || !config.photonApiKey) throw new Error("Photon 2.0 requires PHOTON_PROJECT_ID and PHOTON_API_KEY when PHOTON_ENABLED=true");
    if (!config.photonProviders.length) throw new Error("PHOTON_PROVIDERS must select at least one Photon platform");
    this.stopped = false;
    const photon = this.module ?? await loadPhotonApi();
    const client = new photon.Photon({
      baseUrl: config.photonApiOrigin,
      headers: { Authorization: `Bearer ${config.photonApiKey}` },
      timeoutMs: 30_000,
      retry: { maxAttempts: 3, maximumRetryAfterMs: 60_000 },
    });
    if (this.consumerLease) return { enabled: true, started: true, providers: [...config.photonProviders], cursor: this.cursor, ...(this.apiVersion ? { apiVersion: this.apiVersion } : {}) };
    const lease = await acquirePhotonEventConsumerLease(config.photonProjectId, config.photonEventConsumer, 60);
    if (!lease) {
      this.scheduleLeaseRetry();
      return { enabled: true, started: false, providers: [...config.photonProviders], error: "Another replica owns the Photon event consumer; this replica is standing by." };
    }
    this.consumerLease = lease;
    this.leaseRenewal = setInterval(() => {
      void this.renewConsumerLease();
    }, 20_000);
    this.leaseRenewal.unref?.();
    try {
      const record = await getPhotonEventCursor(config.photonProjectId, config.photonEventConsumer);
      this.cursor = record?.cursor ?? 0;
      this.apiVersion = config.photonApiVersion || record?.apiVersion || undefined;
      this.adapters.clear();
      for (const provider of config.photonProviders) {
        const platform = provider === "whatsapp" ? "whatsapp_business" : provider;
        const channel = channelProvider(platform);
        if (!channel) continue;
        const adapter = new PhotonAdapter(channel, client);
        this.adapters.set(channel, adapter);
        this.options.gateway.register(adapter);
      }
      if (!this.adapters.size) throw new Error("PHOTON_PROVIDERS did not select a supported Photon 2.0 platform");
      this.connect(client);
      logger.info({ providers: config.photonProviders, cursor: this.cursor, apiOrigin: config.photonApiOrigin }, "Photon 2.0 transport ready");
      return { enabled: true, started: true, providers: [...config.photonProviders], cursor: this.cursor, ...(this.apiVersion ? { apiVersion: this.apiVersion } : {}) };
    } catch (error) {
      await this.releaseConsumerLease();
      throw error;
    }
  }

  adapter(provider: PhotonChannelProvider): PhotonAdapter | undefined {
    return this.adapters.get(provider);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.leaseRetry) clearTimeout(this.leaseRetry);
    this.leaseRetry = undefined;
    this.socket?.disconnect();
    this.socket = undefined;
    await this.releaseConsumerLease();
  }

  private async releaseConsumerLease(): Promise<void> {
    if (this.leaseRenewal) clearInterval(this.leaseRenewal);
    this.leaseRenewal = undefined;
    const lease = this.consumerLease;
    this.consumerLease = undefined;
    await lease?.release();
  }

  private scheduleLeaseRetry(force = false): void {
    if ((this.stopped && !force) || this.leaseRetry) return;
    this.leaseRetry = setTimeout(() => {
      this.leaseRetry = undefined;
      void this.start().catch((error) => logger.error({ err: error }, "Photon event consumer retry failed"));
    }, 15_000);
    this.leaseRetry.unref?.();
  }

  private async renewConsumerLease(): Promise<void> {
    const lease = this.consumerLease;
    if (!lease || this.stopped) return;
    try {
      const renewed = await lease.renew();
      if (this.stopped || this.consumerLease !== lease) return;
      if (renewed) return;
    } catch (error) {
      if (this.stopped || this.consumerLease !== lease) return;
      logger.error({ err: error }, "Photon event consumer lease renewal failed");
    }
    logger.error({ projectId: config.photonProjectId, consumer: config.photonEventConsumer }, "Photon event consumer lease was lost; pausing this replica");
    this.consumerLease = undefined;
    if (this.leaseRenewal) clearInterval(this.leaseRenewal);
    this.leaseRenewal = undefined;
    this.socket?.disconnect();
    this.socket = undefined;
    this.stopped = true;
    await lease.release().catch((error) => logger.warn({ err: error }, "Photon event consumer lease release after loss failed"));
    this.scheduleLeaseRetry(true);
  }

  private connect(client: PhotonApiClient): void {
    const factory = this.options.socketFactory ?? ((origin: string, options: Record<string, unknown>) => io(origin, options as any) as unknown as PhotonEventSocket);
    const socket = factory(config.photonApiOrigin, {
      path: `/v1/projects/${config.photonProjectId}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
      extraHeaders: { Authorization: `Bearer ${config.photonApiKey}` },
      autoConnect: false,
    });
    this.socket = socket;
    let epoch = 0;
    let pending = 0;
    let queue = Promise.resolve();
    socket.on("connect", () => {
      const payload = { startSeq: this.cursor, ...(this.apiVersion ? { apiVersion: this.apiVersion } : {}) };
      socket.timeout(10_000).emit("subscribe", payload, (error: unknown, result: PhotonRecord) => {
        const acceptedCursor = Number(result?.startSeq);
        const limits = result?.limits;
        const validAck = result?.ok === true
          && result.projectId === config.photonProjectId
          && typeof result.apiVersion === "string"
          && typeof result.connectionId === "string"
          && acceptedCursor === this.cursor
          && Number.isSafeInteger(limits?.maxFrameBytes) && limits.maxFrameBytes > 0
          && Number.isSafeInteger(limits?.maxReplyBodyBytes) && limits.maxReplyBodyBytes > 0;
        if (error || !validAck) {
          logger.error({ err: error ?? result?.error, cursor: this.cursor }, "Photon 2.0 event subscription failed");
          socket.io.engine.close();
          return;
        }
        this.apiVersion = result.apiVersion;
        void savePhotonEventCursor({ projectId: config.photonProjectId, consumer: config.photonEventConsumer, cursor: this.cursor, apiVersion: this.apiVersion, updatedAt: Date.now() }).catch((saveError) => {
          logger.error({ err: saveError }, "Photon event cursor metadata could not be persisted");
          socket.io.engine.close();
        });
        logger.info({ cursor: this.cursor, apiVersion: this.apiVersion, connectionId: result.connectionId, limits }, "Photon 2.0 event stream subscribed");
      });
    });
    socket.on("delivery", (event: PhotonEvent, metadata: { seq?: number; replyExpected?: boolean }) => {
      const seq = Number(metadata?.seq);
      if (!Number.isSafeInteger(seq) || seq < 0) {
        logger.error({ metadata }, "Photon delivered an invalid event cursor");
        socket.io.engine.close();
        return;
      }
      const generation = epoch;
      if (++pending > config.photonMaxPendingEvents) {
        pending--;
        epoch++;
        socket.io.engine.close();
        return;
      }
      if (metadata?.replyExpected && typeof event?.id === "string" && event.id.length > 0) acknowledgePhotonDelivery(socket, event.id);
      queue = queue.then(async () => {
        if (this.stopped || generation !== epoch || seq <= this.cursor) return;
        await this.dispatchEvent(client, event);
        await savePhotonEventCursor({ projectId: config.photonProjectId, consumer: config.photonEventConsumer, cursor: seq, apiVersion: this.apiVersion, updatedAt: Date.now() });
        this.cursor = seq;
      }).catch((error) => {
        logger.error({ err: error, seq, eventId: event?.id }, "Photon event processing failed; replay will resume from the last saved cursor");
        if (generation === epoch) {
          epoch++;
          socket.io.engine.close();
        }
      }).finally(() => { pending--; });
    });
    socket.on("delivery_error", (error: PhotonRecord) => {
      logger.error({ error }, "Photon event delivery error");
      if (error?.fatal || error?.retryable === false) socket.io.engine.close();
    });
    socket.on("connect_error", (error: unknown) => logger.warn({ err: error }, "Photon 2.0 event connection failed; Socket.IO will reconnect"));
    socket.on("disconnect", (reason: unknown) => logger.warn({ reason, cursor: this.cursor }, "Photon 2.0 event stream disconnected"));
    socket.connect();
  }

  private async dispatchEvent(client: PhotonApiClient, event: PhotonEvent): Promise<void> {
    const raw = photonMessageFromEvent(event);
    if (!raw) return;
    const normalized = await normalizePhotonMessage(raw, {
      projectId: config.photonProjectId,
      defaultScope: config.photonDefaultScope,
      readAttachment: async (attachmentId) => {
        const metadata = await (client as any).projects.getAttachment({ path: { id: config.photonProjectId, attachmentId } });
        if (Number(metadata?.sizeBytes) > MAX_PHOTON_MEDIA_BYTES) throw new Error("Photon attachment is too large");
        const blob = await (client as any).projects.downloadAttachment({ path: { id: config.photonProjectId, attachmentId } });
        const bytes = Buffer.from(await blob.arrayBuffer());
        return { bytes, mimeType: String(metadata?.contentType ?? "application/octet-stream"), filename: typeof metadata?.filename === "string" ? metadata.filename : undefined, sizeBytes: Number(metadata?.sizeBytes) };
      },
    });
    if (normalized) await this.options.gateway.processInbound(normalized);
  }
}
