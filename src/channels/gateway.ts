import { acquireUserLock, claimChannelEvent, completeChannelEvent, releaseChannelEvent, releaseUserLock, renewUserLock } from "../store.js";
import { buildConversation, buildReplyTarget } from "./conversations.js";
import { activateSendblueGroup, redeemLinkCode, resolveIdentity, resolveSendblueGroupAuthorization } from "./identity.js";
import { revokeSendblueGroupAuthorization, saveSendblueGroupAuthorization } from "../store.js";
import { ChannelOutbox } from "./outbox.js";
import type { ChannelAdapter, ChuskyConversation, InboundMessage, OutboundMessage } from "./contracts.js";
import { randomUUID } from "node:crypto";

export type ChannelMessageHandler = (message: InboundMessage, conversation: ChuskyConversation) => Promise<OutboundMessage[] | OutboundMessage | void>;

export interface ChannelProcessResult {
  duplicate: boolean;
  linked: boolean;
  conversation?: ChuskyConversation;
  delivered: string[];
}

export class ChannelGateway {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly outbox: ChannelOutbox;
  private recoveryTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly handler: ChannelMessageHandler, outbox = new ChannelOutbox()) {
    this.outbox = outbox;
  }

  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  adapter(provider: string): ChannelAdapter | undefined {
    return this.adapters.get(provider);
  }

  async send(message: OutboundMessage): Promise<string> {
    const adapter = this.adapters.get(message.target.provider);
    if (!adapter) throw new Error(`No adapter registered for ${message.target.provider}`);
    const record = await this.outbox.send(message, adapter);
    return record.id;
  }

  startRecovery(intervalMs = 30_000): void {
    if (this.recoveryTimer) return;
    void this.outbox.recover(this.adapters).catch(() => undefined);
    this.recoveryTimer = setInterval(() => { void this.outbox.recover(this.adapters).catch(() => undefined); }, intervalMs);
    if (typeof this.recoveryTimer === "object" && "unref" in this.recoveryTimer) this.recoveryTimer.unref();
  }

  stopRecovery(): void {
    if (!this.recoveryTimer) return;
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  async processInbound(message: InboundMessage): Promise<ChannelProcessResult> {
    const adapter = this.adapters.get(message.provider);
    if (!adapter) throw new Error(`No adapter registered for ${message.provider}`);
    if (!(await claimChannelEvent(message.provider, message.providerEventId, 300))) return { duplicate: true, linked: false, delivered: [] };

    try {
    const isSendblueGroup = message.provider === "sendblue" && message.scope === "shared" && Boolean(message.providerWorkspaceId);
    let groupAuthorization = isSendblueGroup ? await resolveSendblueGroupAuthorization(message) : undefined;
    let identity = groupAuthorization ? {
      accountId: groupAuthorization.accountId,
      userId: groupAuthorization.userId,
      provider: "sendblue" as const,
      externalUserId: groupAuthorization.ownerExternalUserId,
      workspaceId: groupAuthorization.workspaceId,
      verifiedAt: groupAuthorization.createdAt,
      createdAt: groupAuthorization.createdAt,
      updatedAt: groupAuthorization.updatedAt,
      proactiveOptIn: true,
    } : await resolveIdentity(message);
    if (groupAuthorization && groupAuthorization.participantPolicy === "owner" && message.providerUserId !== groupAuthorization.ownerExternalUserId) {
      await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: "This iMessage group is restricted to the linked account owner.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-restricted`, kind: "notification" }, adapter);
      await completeChannelEvent(message.provider, message.providerEventId);
      return { duplicate: false, linked: true, delivered: [] };
    }
    if (isSendblueGroup && !groupAuthorization && message.text) {
      const groupLink = message.text.trim().match(/^\/link-group\s+(\d{6})$/i);
      if (groupLink) {
        const linkedOwner = await resolveIdentity(message);
        try {
          if (!linkedOwner) throw new Error("Activate this group from the linked iMessage account");
          groupAuthorization = await activateSendblueGroup(linkedOwner.userId, message, groupLink[1], message.providerUserId);
          await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: "This iMessage group is now linked to Chusky. Everyone in the group can use the shared conversation.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-linked`, kind: "notification" }, adapter);
          await completeChannelEvent(message.provider, message.providerEventId);
          return { duplicate: false, linked: true, delivered: [] };
        } catch (error) {
          await this.outbox.send({ accountId: "unlinked", userId: 0, target: buildReplyTarget(message), text: error instanceof Error ? error.message : "Could not link this iMessage group.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-link-error`, kind: "notification" }, adapter);
          await completeChannelEvent(message.provider, message.providerEventId);
          return { duplicate: false, linked: false, delivered: [] };
        }
      }
    }
    if (!identity && message.text) {
      const match = message.text.trim().match(/^\/link\s+(\d{6})$/i);
      if (match) {
        try {
          identity = await redeemLinkCode(message.provider, match[1], message.providerUserId, message.providerWorkspaceId, message.displayName);
        } catch (error) {
          await this.outbox.send({
            accountId: "unlinked",
            userId: 0,
            target: buildReplyTarget(message),
            text: error instanceof Error ? error.message : "That channel link code is invalid or expired.",
            idempotencyKey: `${message.provider}:${message.providerEventId}:link-error`,
            kind: "notification",
          }, adapter);
          await completeChannelEvent(message.provider, message.providerEventId);
          return { duplicate: false, linked: false, delivered: [] };
        }
      }
    }
    if (!identity) {
      // An unlinked first contact must never enter an account's agent context.
      // A provider adapter may still send a safe link-instructions response.
      await this.outbox.send({
        accountId: "unlinked",
        userId: 0,
        target: buildReplyTarget(message),
        text: "This channel is not linked to a Chusky account yet. In Telegram, use /channel link " + message.provider + " to create a one-time code, then send /link <code> here.",
        idempotencyKey: `${message.provider}:${message.providerEventId}:unlinked`,
        kind: "notification",
      }, adapter);
      await completeChannelEvent(message.provider, message.providerEventId);
      return { duplicate: false, linked: false, delivered: [] };
    }

    if (groupAuthorization && message.text) {
      const command = message.text.trim().toLowerCase();
      if (command === "/unlink-group") {
        if (message.providerUserId !== groupAuthorization.ownerExternalUserId) {
          await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: "Only the linked account owner can unlink this group.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-unlink-denied`, kind: "notification" }, adapter);
        } else {
          await revokeSendblueGroupAuthorization(groupAuthorization.groupId, groupAuthorization.workspaceId, groupAuthorization.userId);
          await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: "This iMessage group has been unlinked from Chusky.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-unlinked`, kind: "notification" }, adapter);
        }
        await completeChannelEvent(message.provider, message.providerEventId);
        return { duplicate: false, linked: true, delivered: [] };
      }
      const access = command.match(/^\/group-access\s+(all|owner)$/);
      if (access) {
        if (message.providerUserId !== groupAuthorization.ownerExternalUserId) {
          await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: "Only the linked account owner can change group access.", idempotencyKey: `${message.provider}:${message.providerEventId}:group-access-denied`, kind: "notification" }, adapter);
        } else {
          groupAuthorization = { ...groupAuthorization, participantPolicy: access[1] as "all" | "owner", updatedAt: Date.now() };
          await saveSendblueGroupAuthorization(groupAuthorization);
          await this.outbox.send({ accountId: groupAuthorization.accountId, userId: groupAuthorization.userId, target: buildReplyTarget(message), text: `Group access is now restricted to ${access[1] === "all" ? "everyone" : "the linked account owner"}.`, idempotencyKey: `${message.provider}:${message.providerEventId}:group-access-updated`, kind: "notification" }, adapter);
        }
        await completeChannelEvent(message.provider, message.providerEventId);
        return { duplicate: false, linked: true, delivered: [] };
      }
    }

    if (message.provider === "sendblue" && message.text) {
      const reaction = message.text.trim().match(/^\/react\s+(love|like|dislike|laugh|emphasize|question)$/i)?.[1]?.toLowerCase() as "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | undefined;
      const handle = message.providerReplyToId;
      if (reaction && handle && adapter.react && message.scope === "private") {
        await adapter.react({ provider: "sendblue", conversationId: message.providerConversationId }, handle, reaction);
        await completeChannelEvent(message.provider, message.providerEventId);
        return { duplicate: false, linked: true, delivered: [] };
      }
    }

    const conversation = buildConversation(identity.userId, message);
    if (!conversation.permissions.canUseAgent) throw new Error("Channel identity is not permitted to use Chusky");
    if (adapter.markRead && message.scope === "private") void adapter.markRead(conversation.replyTarget).catch(() => undefined);
    const lockToken = randomUUID();
    const deadline = Date.now() + 120_000;
    while (!(await acquireUserLock(identity.userId, lockToken, 180))) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for this account's active Chusky request");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const renewal = setInterval(() => { void renewUserLock(identity.userId, lockToken, 180); }, 60_000);
    try {
      if (adapter.typing) {
        try { await adapter.typing(conversation.replyTarget); } catch { /* typing is best-effort */ }
      }
      const response = await this.handler(message, conversation);
      const responses = response ? (Array.isArray(response) ? response : [response]) : [];
      const delivered: string[] = [];
      for (const item of responses) {
        const record = await this.outbox.send({ ...item, accountId: conversation.accountId, userId: conversation.userId, target: item.target ?? conversation.replyTarget }, adapter);
        delivered.push(record.id);
      }
      await completeChannelEvent(message.provider, message.providerEventId);
      return { duplicate: false, linked: true, conversation, delivered };
    } finally {
      if (adapter.stopTyping) {
        try { await adapter.stopTyping(conversation.replyTarget); } catch { /* typing is best-effort */ }
      }
      clearInterval(renewal);
      await releaseUserLock(identity.userId, lockToken);
    }
    } catch (error) {
      await releaseChannelEvent(message.provider, message.providerEventId);
      throw error;
    }
  }
}
