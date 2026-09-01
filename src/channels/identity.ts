import { createHash } from "node:crypto";
import {
  getChannelIdentity,
  listChannelIdentities,
  saveChannelIdentity,
  createChannelLinkCode,
  consumeChannelLinkCode,
  getSendblueGroupAuthorization,
  saveSendblueGroupAuthorization,
  consumeSendblueGroupLinkCode,
  type SendblueGroupAuthorizationRecord,
  type ChannelIdentityRecord,
} from "../store.js";
import type { ChannelProvider, InboundMessage } from "./contracts.js";
import { accountIdForUser } from "./contracts.js";

export function identityKey(provider: ChannelProvider, externalUserId: string, workspaceId?: string): string {
  return `${provider}:${workspaceId ?? "-"}:${externalUserId}`;
}

export async function resolveIdentity(message: Pick<InboundMessage, "provider" | "providerUserId" | "providerWorkspaceId">): Promise<ChannelIdentityRecord | undefined> {
  // A Sendblue direct message has no workspace ID, while a group message uses
  // the Chusky sending number as its workspace ID. Prefer an explicitly
  // group-scoped link, but let a user who linked privately use Chusky in a
  // group too. Other providers remain strictly workspace-scoped.
  const exact = await getChannelIdentity(message.provider, message.providerUserId, message.providerWorkspaceId);
  if (exact || message.provider !== "sendblue" || !message.providerWorkspaceId) return exact;
  return getChannelIdentity(message.provider, message.providerUserId);
}

export async function linkChannelIdentity(userId: number, input: { provider: ChannelProvider; externalUserId: string; workspaceId?: string; displayName?: string }): Promise<ChannelIdentityRecord> {
  const now = Date.now();
  const record: ChannelIdentityRecord = {
    accountId: accountIdForUser(userId),
    userId,
    provider: input.provider,
    externalUserId: input.externalUserId.trim(),
    workspaceId: input.workspaceId?.trim() || undefined,
    displayName: input.displayName?.trim().slice(0, 200),
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
    proactiveOptIn: input.provider === "whatsapp" ? false : true,
  };
  const existing = await getChannelIdentity(record.provider, record.externalUserId, record.workspaceId);
  if (existing && existing.userId !== userId) throw new Error("That channel identity is already linked to another Chusky account");
  if (existing) { record.createdAt = existing.createdAt; record.verifiedAt = existing.verifiedAt; record.proactiveOptIn = existing.proactiveOptIn; record.quietHoursUtc = existing.quietHoursUtc; }
  if (!(await saveChannelIdentity(record))) throw new Error("Could not safely claim that channel identity");
  return record;
}

export async function setProactivePreference(userId: number, provider: ChannelProvider, enabled: boolean): Promise<number> {
  const identities = await listChannelIdentities(userId);
  let changed = 0;
  for (const identity of identities.filter((item) => item.provider === provider)) {
    if (identity.userId !== userId) continue;
    await saveChannelIdentity({ ...identity, proactiveOptIn: enabled, updatedAt: Date.now() });
    changed++;
  }
  return changed;
}

export async function createLinkCode(userId: number, provider: ChannelProvider): Promise<string> {
  return createChannelLinkCode(userId, provider);
}

export async function redeemLinkCode(provider: ChannelProvider, code: string, externalUserId: string, workspaceId?: string, displayName?: string): Promise<ChannelIdentityRecord> {
  const claim = await consumeChannelLinkCode(provider, code);
  if (!claim) throw new Error("Invalid or expired channel link code");
  return linkChannelIdentity(claim.userId, { provider, externalUserId, workspaceId, displayName });
}

export async function listLinkedChannels(userId: number): Promise<ChannelIdentityRecord[]> {
  return listChannelIdentities(userId);
}

export async function activateSendblueGroup(userId: number, message: Pick<InboundMessage, "providerConversationId" | "providerWorkspaceId" | "providerUserId">, code: string, ownerExternalUserId: string): Promise<SendblueGroupAuthorizationRecord> {
  const groupId = message.providerConversationId.trim();
  const workspaceId = message.providerWorkspaceId?.trim() ?? "";
  if (!groupId || !workspaceId || message.providerUserId !== ownerExternalUserId) throw new Error("Only the linked account owner can activate this group");
  if (await getSendblueGroupAuthorization(groupId, workspaceId)) throw new Error("This iMessage group is already linked");
  const claim = await consumeSendblueGroupLinkCode(code);
  if (!claim || claim.userId !== userId) throw new Error("Invalid or expired group link code");
  const now = Date.now();
  const record: SendblueGroupAuthorizationRecord = { provider: "sendblue", groupId, workspaceId, accountId: accountIdForUser(userId), userId, ownerExternalUserId, participantPolicy: "all", createdAt: now, updatedAt: now };
  await saveSendblueGroupAuthorization(record);
  return record;
}

export async function resolveSendblueGroupAuthorization(message: Pick<InboundMessage, "providerConversationId" | "providerWorkspaceId">): Promise<SendblueGroupAuthorizationRecord | undefined> {
  if (!message.providerWorkspaceId) return undefined;
  return getSendblueGroupAuthorization(message.providerConversationId, message.providerWorkspaceId);
}

/** Stable, non-secret fingerprint useful in logs and audit records. */
export function identityFingerprint(record: Pick<ChannelIdentityRecord, "provider" | "externalUserId" | "workspaceId">): string {
  return createHash("sha256").update(identityKey(record.provider, record.externalUserId, record.workspaceId)).digest("hex").slice(0, 16);
}
