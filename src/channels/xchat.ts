import { createHmac } from "node:crypto";
import type { Chat, Message } from "chat";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, ChannelAttachment, DeliveryReceipt, InboundMessage, OutboundMessage, ReplyTarget } from "./contracts.js";

type XchatOfficialAdapter = any;
type XchatRawMessage = {
  event: { id: string; conversationId: string };
  decrypted: { keyVersion?: string } | null;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/** Build the X Activity API CRC response without initializing the full SDK. */
export function createXchatCrcResponse(crcToken: string, consumerSecret: string): { response_token: string } {
  if (!crcToken || !consumerSecret) throw new Error("XChat CRC requires a token and consumer secret");
  const responseToken = createHmac("sha256", consumerSecret).update(crcToken).digest("base64");
  return { response_token: `sha256=${responseToken}` };
}

export interface XchatAdapterOptions {
  accessToken: string;
  pin?: string;
  consumerSecret: string;
  userName?: string;
  verifySignatures?: boolean;
  sendReadReceipts?: boolean;
  maxInboundBytes?: number;
  processInbound: (message: InboundMessage) => Promise<unknown>;
}

const REACTION_EMOJI: Record<NonNullable<OutboundMessage["kind"]> | "love" | "like" | "dislike" | "laugh" | "emphasize" | "question", string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
  message: "💬",
  approval: "✅",
  notification: "🔔",
  receipt: "📬",
};

function attachmentKind(mimeType: string | undefined): ChannelAttachment["kind"] {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("video/")) return "video";
  return "document";
}

function dataUrl(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType || "application/octet-stream"};base64,${bytes.toString("base64")}`;
}

function attachmentFromMessage(message: Message<XchatRawMessage>, index: number): ChannelAttachment {
  const attachment = message.attachments[index];
  const hash = attachment.fetchMetadata?.mediaHashKey ?? attachment.fetchMetadata?.media_hash_key;
  return {
    id: hash ?? attachment.url ?? `${message.id}:${index}`,
    kind: attachmentKind(attachment.mimeType),
    mimeType: attachment.mimeType,
    filename: attachment.name,
    sizeBytes: attachment.size,
    ...(attachment.url ? { url: attachment.url } : {}),
  };
}

/**
 * Official XChat adapter boundary for Chusky's provider-neutral gateway.
 * Chat SDK state is intentionally limited to adapter subscriptions/dispatch;
 * Chusky persists identity, history, locks, approvals, and delivery itself.
 */
export class XchatAdapter implements ChannelAdapter {
  readonly provider = "xchat" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.xchat;
  private official?: XchatOfficialAdapter;
  private chat?: Chat;
  private initialized?: Promise<void>;
  private readonly maxInboundBytes: number;

  constructor(private readonly options: XchatAdapterOptions) {
    if (!options.accessToken) throw new Error("XChat requires an access token");
    if (!options.consumerSecret) throw new Error("XChat requires a consumer secret for webhook verification");
    this.maxInboundBytes = Math.max(256 * 1024, Math.min(options.maxInboundBytes ?? 15 * 1024 * 1024, 25 * 1024 * 1024));
  }

  private async load(): Promise<void> {
    if (this.official && this.chat) return;
    const [chatModule, stateModule, xchatModule] = await Promise.all([
      nativeImport("chat"),
      nativeImport("@chat-adapter/state-memory"),
      nativeImport("@chat-adapter/x/chat"),
    ]);
    this.official = xchatModule.createXchatAdapter({
      accessToken: this.options.accessToken,
      pin: this.options.pin,
      consumerSecret: this.options.consumerSecret,
      userName: this.options.userName,
      verifySignatures: this.options.verifySignatures ?? true,
      sendReadReceipts: this.options.sendReadReceipts ?? true,
    });
    this.chat = new chatModule.Chat({
      userName: this.options.userName || "chusky",
      adapters: { xchat: this.official },
      state: stateModule.createMemoryState(),
    });
    this.chat!.onDirectMessage(async (_thread: unknown, message) => { await this.dispatch(message as Message<XchatRawMessage>); });
    this.chat!.onNewMention(async (_thread: unknown, message) => { await this.dispatch(message as Message<XchatRawMessage>); });
  }

  private async ready(): Promise<{ official: XchatOfficialAdapter; chat: Chat }> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
    return { official: this.official!, chat: this.chat! };
  }

  get cryptoStatus(): string {
    return this.official?.cryptoStatus ?? "uninitialized";
  }

  async initialize(): Promise<void> {
    const { chat } = await this.ready();
    await chat.initialize();
  }

  async handleWebhook(request: Request): Promise<Response> {
    const { chat } = await this.ready();
    return chat.webhooks.xchat(request);
  }

  private async dispatch(message: Message<XchatRawMessage>): Promise<void> {
    const normalized = await this.normalize(message);
    if (normalized) await this.options.processInbound(normalized);
  }

  private async normalize(message: Message<XchatRawMessage>): Promise<InboundMessage | undefined> {
    const raw = message.raw;
    const { official } = await this.ready();
    const conversationId = official.decodeThreadId(message.threadId).conversationId || raw.event.conversationId;
    if (!conversationId || !message.author.userId || !raw.event.id) return undefined;
    const shared = !official.isDM(message.threadId);
    const attachments = await this.hydrateAttachments(message, conversationId);
    return {
      provider: "xchat",
      providerEventId: String(raw.event.id || message.id),
      providerUserId: String(message.author.userId),
      providerConversationId: conversationId,
      ...(shared ? { providerParticipantIds: [String(message.author.userId)] } : {}),
      providerThreadId: message.threadId,
      ...(message.replyTo?.id ? { providerReplyToId: message.replyTo.id } : {}),
      text: message.text.trim() || undefined,
      attachments,
      receivedAt: message.metadata.dateSent instanceof Date ? message.metadata.dateSent.getTime() : Date.now(),
      scope: shared ? "shared" : "private",
      displayName: message.author.fullName || message.author.userName,
    };
  }

  private async hydrateAttachments(message: Message<XchatRawMessage>, conversationId: string): Promise<ChannelAttachment[]> {
    const raw = message.raw;
    const { official } = await this.ready();
    const entries = raw.decrypted ? (await nativeImport("@chat-adapter/x/chat")).extractMediaEntries(raw.decrypted) : [];
    if (!entries.length) return message.attachments.slice(0, 10).map((_, index) => attachmentFromMessage(message, index));
    const output: ChannelAttachment[] = [];
    for (const [index, entry] of entries.slice(0, 10).entries()) {
      const source = message.attachments[index];
      const mimeType = entry.mediaType || source?.mimeType || "application/octet-stream";
      const attachment: ChannelAttachment = {
        id: entry.hashKey,
        kind: attachmentKind(mimeType),
        mimeType,
        filename: entry.filename || source?.name,
        sizeBytes: entry.filesize,
      };
      try {
        if (!entry.hashKey) throw new Error("missing media hash");
        const bytes = await official.fetchMediaAttachment(conversationId, entry.hashKey, raw.decrypted?.keyVersion);
        if (!bytes.length) { output.push({ ...attachment, mediaError: "empty_media" }); continue; }
        if (bytes.length > this.maxInboundBytes) { output.push({ ...attachment, mediaError: "too_large" }); continue; }
        output.push({ ...attachment, sizeBytes: bytes.length, url: dataUrl(mimeType, bytes) });
      } catch {
        output.push({ ...attachment, mediaError: "download_failed" });
      }
    }
    return output;
  }

  private threadId(target: ReplyTarget): string {
    const threadId = target.threadId || target.metadata?.threadId;
    if (!threadId) throw new Error("XChat delivery requires a conversation thread");
    return threadId;
  }

  private async post(official: XchatOfficialAdapter, threadId: string, message: OutboundMessage): Promise<string> {
    const attachments = (message.attachments ?? []).slice(0, 10).map((item) => {
      const base = { type: item.kind === "document" ? "file" as const : item.kind, mimeType: item.mimeType, name: item.filename };
      if (item.url?.startsWith("data:")) return { ...base, data: Buffer.from(item.url.slice(item.url.indexOf(",") + 1), "base64") };
      if (item.url?.startsWith("https://")) return { ...base, fetchData: async () => {
        const response = await fetch(item.url!, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`XChat attachment download failed: ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > this.maxInboundBytes) throw new Error("XChat attachment is too large");
        return bytes;
      } };
      return base;
    });
    const text = (message.text ?? "").slice(0, this.capabilities.maxTextLength);
    const result = await official.postMessage(threadId, attachments.length ? { raw: text, attachments } : { raw: text });
    return String((result as { id?: string }).id ?? "");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    const threadId = message.target.threadId || (await official.openDM(message.target.conversationId));
    const providerMessageId = await this.post(official, threadId, message);
    return { providerMessageId: providerMessageId || undefined, deliveredAt: Date.now(), metadata: { threadId } };
  }

  async typing(target: ReplyTarget): Promise<void> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    await official.startTyping(this.threadId(target));
  }

  async stopTyping(_target: ReplyTarget): Promise<void> {
    // XChat typing pills expire and the official adapter stops them after the
    // next post. There is no public stop method; keep this best-effort no-op.
  }

  async markRead(target: ReplyTarget): Promise<void> {
    // The official adapter acknowledges inbound messages before handlers run.
    // The provider-neutral gateway does not carry a message ID here.
    void target;
  }

  async react(target: ReplyTarget, messageHandle: string, reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"): Promise<void> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    await official.addReaction(this.threadId(target), messageHandle, REACTION_EMOJI[reaction]);
  }

  async edit(target: ReplyTarget, providerMessageId: string, text: string): Promise<DeliveryReceipt> {
    const { official, chat } = await this.ready();
    await chat.initialize();
    const result = await official.editMessage(this.threadId(target), providerMessageId, { raw: text.slice(0, this.capabilities.maxTextLength) });
    return { providerMessageId: String((result as { id?: string }).id ?? providerMessageId), deliveredAt: Date.now() };
  }
}
