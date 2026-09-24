import {
  claimOutbox,
  enqueueOutbox,
  getOutbox,
  listOutbox,
  updateOutbox,
  type OutboxRecord,
} from "../store.js";
import type { ChannelAdapter, OutboundMessage, DeliveryReceipt } from "./contracts.js";
import { recordFailure } from "../monitoring.js";

const DELIVERY_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const RECOVERY_CONCURRENCY = 4;

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
      targetMetadata: message.target.metadata,
      text: message.text,
      blocks: message.blocks,
      interactive: message.interactive,
      template: message.template,
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
    if (record.status === "ambiguous") throw new Error(`Delivery ${record.id} has an uncertain provider outcome. Check the destination before manually retrying.`);
    if (record.attempts >= MAX_DELIVERY_ATTEMPTS) throw new Error(`Outbound delivery ${record.id} exhausted retry attempts`);
    const claimed = await claimOutbox(record.id, DELIVERY_LEASE_MS);
    if (!claimed) {
      const current = (await getOutbox(record.id)) ?? record;
      if (current.status === "delivering") throw new Error(`Delivery ${record.id} is already in progress; check its status before retrying.`);
      if (current.status === "ambiguous") throw new Error(`Delivery ${record.id} has an uncertain provider outcome. Check the destination before manually retrying.`);
      if (current.status === "delivered") return current;
      throw new Error(`Delivery ${record.id} could not be claimed (current status: ${current.status}).`);
    }
    try {
      const receipt = await adapter.send({
        accountId: claimed.accountId,
        userId: claimed.userId,
        target,
        text: claimed.text,
        blocks: claimed.blocks,
        interactive: claimed.interactive,
        template: claimed.template,
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
      recordFailure("delivery_failure", error, { provider: claimed.provider, outboxId: record.id });
      const ambiguous = await updateOutbox(record.id, {
        status: "ambiguous",
        lastError: `Provider outcome is uncertain; check the destination before manually retrying. ${message}`.slice(0, 1000),
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      throw new Error(`Outbound delivery outcome is uncertain; check the destination before manually retrying. ${message}`, { cause: ambiguous });
    }
  }

  async send(message: OutboundMessage, adapter: ChannelAdapter): Promise<OutboxRecord> {
    if (message.template && !adapter.capabilities.supportsTemplates) {
      throw new Error(`The ${adapter.provider} adapter does not support approved templates`);
    }
    const record = await this.enqueue(message);
    return this.deliver(record, adapter, message.target);
  }

  async recover(adapters: Map<string, ChannelAdapter>, limit = 100): Promise<number> {
    const records = await listOutbox(["queued", "delivering"], limit);
    let recovered = 0;
    for (let offset = 0; offset < records.length; offset += RECOVERY_CONCURRENCY) {
      const batch = records.slice(offset, offset + RECOVERY_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (record) => {
        const adapter = adapters.get(record.provider);
        if (!adapter) return false;
        try {
          const result = await this.deliver(record, adapter, {
            provider: record.provider,
            conversationId: record.conversationId,
            threadId: record.threadId,
            workspaceId: record.workspaceId,
            metadata: record.targetMetadata,
          });
          return result.status === "delivered";
        } catch { return false; /* failure state is persisted for operator diagnosis */ }
      }));
      recovered += outcomes.filter(Boolean).length;
    }
    return recovered;
  }
}
