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
  return {
    provider: message.provider,
    conversationId: message.providerConversationId,
    threadId: message.providerThreadId,
    workspaceId: message.providerWorkspaceId,
  };
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

