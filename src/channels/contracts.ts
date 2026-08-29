/**
 * Provider-neutral channel contracts.
 *
 * Channel adapters translate provider payloads at the edge. The agent, memory,
 * task, and approval layers only consume these contracts and never inspect a
 * Slack/WhatsApp/Telegram payload directly.
 */

export type ChannelProvider = "telegram" | "slack" | "whatsapp" | "sms" | "voice" | "cli" | "webhook";

export type AttachmentKind = "image" | "audio" | "video" | "document";

export interface ChannelAttachment {
  id: string;
  kind: AttachmentKind;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  /** A provider URL or a short-lived data URL. Never persist raw provider payloads. */
  url?: string;
}

export interface ChannelInteraction {
  kind: "approval" | "button" | "form";
  id: string;
  value?: string;
}

export interface InboundMessage {
  provider: ChannelProvider;
  /** Provider event ID, used as a durable idempotency key. */
  providerEventId: string;
  providerUserId: string;
  providerWorkspaceId?: string;
  providerConversationId: string;
  providerThreadId?: string;
  text?: string;
  attachments: ChannelAttachment[];
  interaction?: ChannelInteraction;
  receivedAt: number;
  /** Private means a 1:1 conversation; shared scopes must not use private memory. */
  scope: "private" | "shared";
  displayName?: string;
}

export interface ReplyTarget {
  provider: ChannelProvider;
  conversationId: string;
  threadId?: string;
  workspaceId?: string;
  /** Provider-specific delivery data, kept in memory only. */
  metadata?: Record<string, string>;
}

export interface PermissionSet {
  canUseAgent: boolean;
  canApprove: boolean;
  canUseSharedContext: boolean;
  canReceiveProactive: boolean;
}

export interface ChuskyConversation {
  accountId: string;
  userId: number;
  provider: ChannelProvider;
  scope: "private" | "shared";
  conversationId: string;
  threadId?: string;
  permissions: PermissionSet;
  replyTarget: ReplyTarget;
}

export interface OutboundMessage {
  accountId: string;
  userId: number;
  target: ReplyTarget;
  text?: string;
  /** Channel-native blocks, e.g. Slack Block Kit. */
  blocks?: unknown[];
  interactive?: {
    kind: "buttons";
    body: string;
    buttons: Array<{ id: string; title: string }>;
  };
  attachments?: ChannelAttachment[];
  idempotencyKey: string;
  /** The originating event/task/approval, for audit and delivery correlation. */
  correlationId?: string;
  kind?: "message" | "approval" | "notification" | "receipt";
}

export interface DeliveryReceipt {
  providerMessageId?: string;
  deliveredAt: number;
  metadata?: Record<string, string>;
}

export interface ChannelCapabilities {
  supportsThreads: boolean;
  supportsStreaming: boolean;
  supportsFiles: boolean;
  supportsMarkdown: boolean;
  supportsButtons: boolean;
  supportsTyping: boolean;
  maxTextLength: number;
}

export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  readonly capabilities: ChannelCapabilities;
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
  edit?(target: ReplyTarget, providerMessageId: string, text: string, blocks?: unknown[]): Promise<DeliveryReceipt>;
  typing?(target: ReplyTarget): Promise<void>;
}

export class ChannelVerificationError extends Error {
  readonly statusCode: 401 | 403 | 400 | 503;

  constructor(message: string, statusCode: 401 | 403 | 400 | 503 = 401) {
    super(message);
    this.name = "ChannelVerificationError";
    this.statusCode = statusCode;
  }
}

export function accountIdForUser(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid Chusky user ID");
  return `account_${userId}`;
}

export function conversationIdFor(message: Pick<InboundMessage, "provider" | "providerConversationId" | "providerWorkspaceId" | "providerThreadId">): string {
  const workspace = message.providerWorkspaceId ?? "-";
  const thread = message.providerThreadId ?? "-";
  return `${message.provider}:${workspace}:${message.providerConversationId}:${thread}`;
}
