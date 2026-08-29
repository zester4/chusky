import { claimOutbox, enqueueOutbox, listOutbox, updateOutbox, type OutboxRecord } from "../store.js";
import { deliverWebhook } from "./webhooks.js";
import { createHash } from "node:crypto";

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;

export async function enqueueSdkWebhook(userId: number, hook: { id: string; url: string; secretCiphertext: string }, type: string, data: unknown): Promise<OutboxRecord> {
  const payloadHash = createHash("sha256").update(JSON.stringify({ type, data })).digest("hex");
  return enqueueOutbox({
    idempotencyKey: `sdk-webhook:${hook.id}:${payloadHash}`,
    accountId: `sdk:${userId}`,
    userId,
    provider: "webhook",
    conversationId: hook.id,
    kind: "notification",
    webhook: { webhookId: hook.id, url: hook.url, secretCiphertext: hook.secretCiphertext, payload: { type, data } },
  });
}

export async function deliverSdkWebhook(record: OutboxRecord): Promise<OutboxRecord> {
  if (record.provider !== "webhook" || !record.webhook) throw new Error("Not an SDK webhook delivery");
  if (record.status === "delivered") return record;
  if (record.attempts >= MAX_ATTEMPTS) return (await updateOutbox(record.id, { status: "failed", lastError: "retry_exhausted" })) ?? record;
  const claimed = await claimOutbox(record.id, LEASE_MS);
  if (!claimed) return record;
  const result = await deliverWebhook({ id: claimed.webhook!.webhookId, url: claimed.webhook!.url, secretCiphertext: claimed.webhook!.secretCiphertext }, claimed.webhook!.payload);
  return (await updateOutbox(record.id, result.delivered
    ? { status: "delivered", deliveredAt: Date.now(), providerStatus: String(result.status ?? 200), leaseToken: undefined, leaseExpiresAt: undefined, lastError: undefined }
    : { status: "failed", providerStatus: result.status ? String(result.status) : undefined, lastError: result.error ?? "delivery_failed", leaseToken: undefined, leaseExpiresAt: undefined })) ?? claimed;
}

export async function recoverSdkWebhooks(limit = 100): Promise<number> {
  const records = (await listOutbox(["queued", "failed", "delivering"], limit)).filter((record) => record.provider === "webhook" && record.webhook);
  let delivered = 0;
  for (const record of records) if ((await deliverSdkWebhook(record)).status === "delivered") delivered++;
  return delivered;
}
