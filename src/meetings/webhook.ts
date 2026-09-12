import { createHmac, randomUUID } from "node:crypto";
import { verifyRecallWebhookSignature } from "./recall.js";
import type { ParsedRecallChatWebhook } from "./recall.js";
import type { RecallChatEventRecord } from "../store.js";

export interface RecallRealtimeWebhookResult {
  status: 202 | 204 | 400 | 401 | 409 | 503;
  queued?: boolean;
}

export type RecallStatusWebhookOutcome = "processed" | "duplicate" | "retry";

/** Reconcile under a tokenized lease; busy deliveries receive retryable status, not a false 2xx. */
export async function processRecallStatusWebhook(input: {
  key: string;
  body: unknown;
  claim(key: string, token: string, leaseMs: number): Promise<"acquired" | "completed" | "busy">;
  reconcile(body: unknown): Promise<unknown>;
  complete(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
}): Promise<RecallStatusWebhookOutcome> {
  const token = randomUUID();
  const claim = await input.claim(input.key, token, 60_000);
  if (claim === "completed") return "duplicate";
  if (claim === "busy") return "retry";
  try {
    await input.reconcile(input.body);
    if (!(await input.complete(input.key, token, 30 * 24 * 60 * 60))) throw new Error("Recall status webhook lease was lost");
    return "processed";
  } catch {
    // If release itself is unavailable, the tokenized claim expires and a
    // subsequent provider attempt remains retryable rather than being acked.
    try { await input.release(input.key, token); } catch { /* TTL is the fallback. */ }
    return "retry";
  }
}

/** Verify, normalize, durably store and enqueue one Recall event. Queue bodies stay ID-only. */
export async function receiveRecallChatWebhook(input: {
  secret: string;
  rawBody: string;
  headers: Headers;
  resolve(body: unknown): Promise<ParsedRecallChatWebhook | undefined>;
  create(record: RecallChatEventRecord): Promise<RecallChatEventRecord>;
  update(eventId: string, patch: Partial<RecallChatEventRecord>): Promise<RecallChatEventRecord | undefined>;
  enqueue(eventId: string, record: RecallChatEventRecord): Promise<string>;
}): Promise<RecallRealtimeWebhookResult> {
  if (!verifyRecallWebhookSignature({ secret: input.secret, body: input.rawBody, headers: input.headers })) return { status: 401 };
  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { status: 400 };
  }
  const providerEventId = input.headers.get("webhook-id") ?? input.headers.get("svix-id") ?? "";
  if (!providerEventId || providerEventId.length > 200) return { status: 401 };

  let addressed: ParsedRecallChatWebhook | undefined;
  try {
    addressed = await input.resolve(body);
  } catch {
    return { status: 503 };
  }
  if (!addressed) return { status: 204 };
  const eventId = `rch_${createHmac("sha256", input.secret).update(providerEventId).digest("hex")}`;
  const record: RecallChatEventRecord = {
    eventId,
    userId: addressed.userId,
    meetingId: addressed.meetingId,
    providerBotId: addressed.providerBotId,
    command: addressed.command,
    ...(addressed.replyToParticipantId ? { replyToParticipantId: addressed.replyToParticipantId } : {}),
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    const stored = await input.create(record);
    if (stored.userId !== addressed.userId || stored.meetingId !== addressed.meetingId || stored.providerBotId !== addressed.providerBotId) return { status: 409 };
    if (stored.status === "completed" || stored.workflowRunId) return { status: 204 };
    const workflowRunId = await input.enqueue(eventId, stored);
    if (!(await input.update(eventId, { workflowRunId }))) return { status: 503 };
    return { status: 202, queued: true };
  } catch {
    // Provider retries are useful only when the record or QStash enqueue fails.
    // No participant text or raw provider payload is returned or logged here.
    return { status: 503 };
  }
}
