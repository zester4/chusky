import { createHash } from "node:crypto";
import type { ChuskyConversation, InboundMessage, PermissionSet, ReplyTarget } from "./contracts.js";
import { accountIdForUser, conversationIdFor } from "./contracts.js";

export function privatePermissions(): PermissionSet {
  return { canUseAgent: true, canApprove: true, canUseSharedContext: false, canReceiveProactive: true };
}

export function sharedPermissions(): PermissionSet {
  return { canUseAgent: true, canApprove: false, canUseSharedContext: true, canReceiveProactive: false };
}

export function buildReplyTarget(message: InboundMessage): ReplyTarget {
  const photonTarget = message.provider.startsWith("photon_") ? {
    photonProjectId: message.providerWorkspaceId,
    photonAgentId: message.providerAgentId,
    photonPlatform: message.provider === "photon_imessage"
      ? "imessage"
      : message.provider === "photon_whatsapp"
        ? "whatsapp_business"
        : message.provider === "photon_telegram"
          ? "telegram"
          : message.provider === "photon_sms"
            ? "sms"
            : "email",
    photonParentMessageId: message.providerEventId,
  } : undefined;
  return {
    provider: message.provider,
    conversationId: message.providerConversationId,
    threadId: message.providerThreadId,
    workspaceId: message.providerWorkspaceId,
    ...(message.provider === "sendblue" ? {
      metadata: {
        ...(message.scope === "shared" ? {
          groupId: message.providerConversationId,
          ...(message.provider === "sendblue" && message.providerParticipantIds?.length
            ? { groupParticipants: JSON.stringify(message.providerParticipantIds) }
            : {}),
        } : {}),
        messageHandle: message.providerEventId,
        ...(message.providerReplyToId ? { replyToHandle: message.providerReplyToId } : {}),
      },
    } : photonTarget ? {
      metadata: Object.fromEntries(Object.entries(photonTarget).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)),
    } : {}),
  };
}

/**
 * Shared-channel sender metadata is conversation context, not authorization.
 * Keep a stable fallback label when a provider does not expose a display name
 * so the model can still distinguish participants without seeing raw IDs.
 */
export function sharedSenderLabel(message: Pick<InboundMessage, "provider" | "providerUserId" | "displayName" | "scope">): string {
  const name = message.displayName?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (name) return name;
  const digest = createHash("sha256").update(`${message.provider}:${message.providerUserId}`).digest("hex").slice(0, 8).toUpperCase();
  const label = message.provider === "sendblue" || message.provider === "photon_imessage"
    ? "iMessage"
    : message.provider === "photon_whatsapp"
      ? "WhatsApp"
      : message.provider === "photon_telegram"
        ? "Telegram"
        : message.provider === "photon_sms"
          ? "SMS"
          : message.provider === "photon_email"
            ? "email"
        : message.provider;
  return `${label} participant ${digest}`;
}

/** Prefix shared turns so the agent can attribute each message correctly. */
export function formatInboundMessageForAgent(message: InboundMessage, text: string): string {
  if (message.scope !== "shared") return text;
  return `[${sharedSenderLabel(message)}]: ${text}`;
}

export function buildConversation(userId: number, message: InboundMessage): ChuskyConversation {
  const scope = message.scope;
  return {
    accountId: accountIdForUser(userId),
    userId,
    provider: message.provider,
    scope,
    conversationId: conversationIdFor(message),
    threadId: message.providerThreadId,
    permissions: scope === "private" ? privatePermissions() : sharedPermissions(),
    replyTarget: buildReplyTarget(message),
  };
}

export function sharedConversationId(provider: string, workspaceId: string, conversationId: string): string {
  return `shared_${createHash("sha256").update(`${provider}:${workspaceId}:${conversationId}`).digest("hex").slice(0, 32)}`;
}
