import {
  claimOutbox,
  enqueueOutbox,
  getOutbox,
  listOutbox,
  updateOutbox,
  type OutboxRecord,
} from "../store.js";
import type { ChannelAdapter, OutboundMessage, DeliveryReceipt } from "./contracts.js";

const DELIVERY_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;

export class ChannelOutbox {
  async enqueue(message: OutboundMessage): Promise<OutboxRecord> {
    return enqueueOutbox({
      idempotencyKey: message.idempotencyKey,
      accountId: message.accountId,
      userId: message.userId,
      provider: message.target.provider,
      conversationId: message.target.conversationId,
      threadId: message.target.threadId,
      workspaceId: message.target.workspaceId,
      text: message.text,
      blocks: message.blocks,
      interactive: message.interactive,
      attachments: message.attachments,
      correlationId: message.correlationId,
      kind: message.kind ?? "message",
    });
  }

  /**
   * Claim, deliver, and settle one message. A stale lease can be reclaimed
   * after a process crash, while an active lease prevents duplicate sends
   * across replicas. Provider APIs should receive the stable idempotency key
   * where they support one.
   */
  async deliver(record: OutboxRecord, adapter: ChannelAdapter, target: OutboundMessage["target"]): Promise<OutboxRecord> {
    if (record.status === "delivered") return record;
    if (record.attempts >= MAX_DELIVERY_ATTEMPTS) throw new Error(`Outbound delivery ${record.id} exhausted retry attempts`);
    const claimed = await claimOutbox(record.id, DELIVERY_LEASE_MS);
    if (!claimed) return (await getOutbox(record.id)) ?? record;
    try {
      const receipt = await adapter.send({
        accountId: claimed.accountId,
        userId: claimed.userId,
        target,
        text: claimed.text,
        blocks: claimed.blocks,
        interactive: claimed.interactive,
        attachments: claimed.attachments,
        idempotencyKey: claimed.idempotencyKey,
        correlationId: claimed.correlationId,
        kind: claimed.kind,
      });
      return (await updateOutbox(record.id, {
        status: "delivered",
        providerMessageId: receipt.providerMessageId,
        deliveredAt: receipt.deliveredAt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
      })) ?? claimed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await updateOutbox(record.id, {
        status: "failed",
        lastError: message.slice(0, 1000),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      throw new Error(`Outbound delivery failed: ${message}`, { cause: failed });
    }
  }

  async send(message: OutboundMessage, adapter: ChannelAdapter): Promise<OutboxRecord> {
    const record = await this.enqueue(message);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.deliver(record, adapter, message.target); }
      catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async recover(adapters: Map<string, ChannelAdapter>, limit = 100): Promise<number> {
    const records = await listOutbox(["queued", "failed", "delivering"], limit);
    let recovered = 0;
    for (const record of records) {
      const adapter = adapters.get(record.provider);
      if (!adapter) continue;
      try {
        await this.deliver(record, adapter, { provider: record.provider, conversationId: record.conversationId, threadId: record.threadId, workspaceId: record.workspaceId });
        recovered++;
      } catch { /* leave failed record for the next bounded recovery pass */ }
    }
    return recovered;
  }
}
