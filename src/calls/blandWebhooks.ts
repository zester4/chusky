import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  claimDeliveryLease,
  completeDeliveryLease,
  finalizeBlandPhoneCall,
  getBlandPhoneCallByProviderId,
  getPhoneCall,
  releaseDeliveryLease,
  appendPhoneCallEvent,
  updatePhoneCall,
  type Message,
  type PhoneCallRecord,
} from "../store.js";
import { isValidBlandToolSecret, readBlandCallToken, verifyBlandWebhookSignature } from "./blandSecurity.js";
import { normalizeBlandInboundNumber, registerBlandInboundCall, type BlandInboundRoute } from "./blandInbound.js";
import { schedulePhoneCallFollowUps } from "./followUp.js";
import { scorePhoneCallTrace } from "./voiceEvaluation.js";
import { providerStatusCanAdvance } from "./voiceEvents.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_BYTES = 16 * 1024;
const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const LEASE_MS = 30_000;

export interface BlandWebhookResult {
  status: number;
  body: { ok: boolean; error?: string; duplicate?: boolean };
}

function fail(status: number, error: string): BlandWebhookResult {
  return { status, body: { ok: false, error } };
}

function parseObject(raw: string, maxBytes: number): Record<string, unknown> | undefined {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function providerCallId(body: Record<string, unknown>): string | undefined {
  const value = typeof body.call_id === "string" ? body.call_id.trim() : "";
  return /^[A-Za-z0-9_-]{6,160}$/.test(value) ? value : undefined;
}

function isPostCall(body: Record<string, unknown>): boolean {
  return body.completed === true
    || String(body.queue_status ?? "").toLowerCase() === "complete"
    || Array.isArray(body.transcripts)
    || typeof body.concatenated_transcript === "string";
}

function callbackIdentity(body: Record<string, unknown>, token: string | undefined, secret: string) {
  if (token) return readBlandCallToken(token, secret);
  // Compatibility for callbacks from calls created by earlier Chusky versions.
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown> : {};
  const callId = typeof metadata.chusky_call_id === "string" ? metadata.chusky_call_id.trim() : "";
  const userId = Number(metadata.chusky_user_id);
  return /^blc_[0-9a-f-]{36}$/i.test(callId) && Number.isSafeInteger(userId) && userId > 0
    ? { callId, userId }
    : undefined;
}

function cleanedTurn(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, 4000) : "";
}

/** Preserve caller/agent roles from Bland's documented `transcripts[]` payload. */
export function blandTranscriptMessages(body: Record<string, unknown>, localCallId: string): Message[] {
  const messages: Message[] = [];
  const transcript = Array.isArray(body.transcripts) ? body.transcripts.slice(0, 500) : [];
  for (const entry of transcript) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const text = cleanedTurn(item.text);
    const speaker = typeof item.user === "string" ? item.user.toLowerCase() : "";
    if (!text || (speaker !== "user" && speaker !== "assistant" && speaker !== "robot")) continue;
    messages.push({ role: speaker === "user" ? "user" : "assistant", content: `[Bland call ${localCallId}] ${text}` });
  }
  if (messages.length || typeof body.concatenated_transcript !== "string") return messages;

  // Older/partial payloads can omit the structured array. Parse only explicitly
  // speaker-labelled lines; never misfile the whole transcript as assistant text.
  let activeRole: Message["role"] | undefined;
  let activeText: string[] = [];
  const flush = () => {
    const text = cleanedTurn(activeText.join(" "));
    if (activeRole && text) messages.push({ role: activeRole, content: `[Bland call ${localCallId}] ${text}` });
    activeText = [];
  };
  for (const line of body.concatenated_transcript.split(/\r?\n/).slice(0, 500)) {
    const match = line.match(/^\s*(user|assistant|robot|agent-action)\s*:\s*(.*)$/i);
    if (match) {
      flush();
      const speaker = match[1]!.toLowerCase();
      activeRole = speaker === "user" ? "user" : speaker === "agent-action" ? undefined : "assistant";
      if (activeRole) activeText.push(match[2]!);
    } else if (activeRole && activeText.length < 60) {
      activeText.push(line);
    }
  }
  flush();
  return messages;
}

function blandCallStatus(body: Record<string, unknown>, isFinal: boolean): "starting" | "bridging" | "active" | "ended" | "failed" | undefined {
  if (isFinal) {
    const failed = typeof body.error_message === "string" && body.error_message.trim().length > 0;
    const complete = body.completed === true || String(body.queue_status ?? "").toLowerCase() === "complete";
    return failed ? "failed" : complete ? "ended" : undefined;
  }
  const category = String(body.category ?? "").toLowerCase();
  const message = String(body.message ?? "").toLowerCase();
  const level = String(body.log_level ?? "").toLowerCase();
  if ((category === "queue" || category === "call") && level === "error") return "failed";
  if (category === "call" && /\b(call )?(started|connected|answered|in progress)\b/.test(message)) return "active";
  if (category === "call" && /\b(call )?(ended|finished|completed|disconnected)\b/.test(message)) return "ended";
  if (category === "queue") return "bridging";
  return undefined;
}

function blandProviderStatus(body: Record<string, unknown>, isFinal: boolean): NonNullable<PhoneCallRecord["providerStatus"]> | undefined {
  const failed = typeof body.error_message === "string" && body.error_message.trim().length > 0;
  if (isFinal) return failed ? "failed" : (body.completed === true || String(body.queue_status ?? "").toLowerCase() === "complete") ? "completed" : undefined;
  const message = `${String(body.message ?? "")} ${String(body.status ?? "")}`.toLowerCase();
  const category = String(body.category ?? "").toLowerCase();
  const level = String(body.log_level ?? "").toLowerCase();
  if ((category === "queue" || category === "call") && level === "error") return "failed";
  if (/\b(ringing|ring)\b/.test(message)) return "ringing";
  if (/\b(connected|answered|in progress)\b/.test(message)) return "in-progress";
  if (/\b(ended|finished|completed|disconnected)\b/.test(message)) return "completed";
  if (/\b(started|queued|dialing)\b/.test(message) || category === "queue") return "initiated";
  return undefined;
}

function blandLifecycleEvent(providerStatus: NonNullable<PhoneCallRecord["providerStatus"]>): { type: "call_initiated" | "call_ringing" | "call_answered" | "call_ended" | "call_failed"; summary: string } | undefined {
  if (providerStatus === "initiated") return { type: "call_initiated", summary: "Bland accepted the call and began dialing." };
  if (providerStatus === "ringing") return { type: "call_ringing", summary: "The destination is ringing." };
  if (providerStatus === "in-progress" || providerStatus === "answered") return { type: "call_answered", summary: "The call was answered and the voice session is active." };
  if (providerStatus === "completed") return { type: "call_ended", summary: "The call ended normally." };
  if (providerStatus === "failed") return { type: "call_failed", summary: "Bland reported that the call failed." };
  return undefined;
}

function safeError(body: Record<string, unknown>): string | undefined {
  if (typeof body.error_message !== "string" || !body.error_message.trim()) return undefined;
  return body.error_message.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, 500);
}

function boundedOutcomeText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : undefined;
}

function blandOutcome(body: Record<string, unknown>): { title: string; summary: string; decisions: string[]; actionItems: Array<{ task: string; owner: string; dueDate?: string }>; openQuestions: string[] } | undefined {
  const summary = typeof body.summary === "string" ? body.summary.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 2_000) : "";
  if (!summary) return undefined;
  const list = (value: unknown, maximum: number): string[] => Array.isArray(value)
    ? value.flatMap((entry) => { const item = boundedOutcomeText(entry, maximum); return item ? [item] : []; }).slice(0, 10)
    : [];
  const rawItems = Array.isArray(body.action_items) ? body.action_items : Array.isArray(body.actionItems) ? body.actionItems : [];
  const actionItems = rawItems.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const task = boundedOutcomeText(item.task, 500);
    const owner = boundedOutcomeText(item.owner, 120);
    if (!task || !owner) return [];
    const dueDate = boundedOutcomeText(item.dueDate ?? item.due_date, 80);
    return [{ task, owner, ...(dueDate ? { dueDate } : {}) }];
  });
  return { title: boundedOutcomeText(body.outcome_title ?? body.title, 180) ?? "Bland call outcome", summary, decisions: list(body.decisions, 700), actionItems, openQuestions: list(body.open_questions ?? body.openQuestions, 700) };
}

export async function processBlandWebhook(input: {
  rawBody: string;
  signature: string;
  callbackToken?: string;
  inboundRoute?: BlandInboundRoute;
  secret: string;
}): Promise<BlandWebhookResult> {
  if (!verifyBlandWebhookSignature(input.rawBody, input.signature, input.secret)) return fail(401, "invalid Bland webhook signature");
  const body = parseObject(input.rawBody, MAX_WEBHOOK_BYTES);
  if (!body) return fail(Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BYTES ? 413 : 400, "invalid Bland webhook payload");
  let identity = callbackIdentity(body, input.callbackToken, input.secret);
  const callId = providerCallId(body);
  const postCall = isPostCall(body);
  if (input.callbackToken && !identity) return fail(401, "invalid Bland callback token");
  if (input.callbackToken && input.inboundRoute) return fail(400, "Bland callback cannot use both call and inbound route identities");
  if (input.inboundRoute && body.inbound === false) return fail(400, "Bland payload is not an inbound call");
  if (input.inboundRoute && postCall && body.inbound !== true) return fail(400, "Bland post-call payload is missing inbound direction");

  let call: Awaited<ReturnType<typeof getPhoneCall>>;
  if (!identity && input.inboundRoute && callId) {
    const inbound = await registerBlandInboundCall({ route: input.inboundRoute, providerCallId: callId, from: body.from });
    identity = { userId: inbound.userId, callId: inbound.id };
    call = inbound;
  }
  if (!identity || !callId || (!input.callbackToken && !input.inboundRoute && !postCall)) return fail(400, "invalid Bland callback identity or event");

  call ??= await getPhoneCall(identity.userId, identity.callId);
  if (!call || call.provider !== "bland") return fail(404, "unknown Bland call");
  if (call.providerCallId && call.providerCallId !== callId) return fail(409, "Bland call ID mismatch");

  const eventDigest = createHash("sha256").update(input.rawBody).digest("hex");
  const deliveryKey = postCall ? `bland-postcall:${call.id}` : `bland-event:${call.id}:${eventDigest}`;
  const leaseToken = randomBytes(24).toString("base64url");
  const claim = await claimDeliveryLease(deliveryKey, leaseToken, LEASE_MS);
  if (claim === "completed") return { status: 200, body: { ok: true, duplicate: true } };
  if (claim === "busy") return fail(503, "Bland callback is already being processed");

  try {
    if (postCall) {
      const callLength = Number(body.call_length);
      const outcome = blandOutcome(body);
      const providerStatus = blandProviderStatus(body, true);
      if (providerStatus && providerStatusCanAdvance(call.providerStatus, providerStatus)) {
        const lifecycle = blandLifecycleEvent(providerStatus);
        if (lifecycle) await appendPhoneCallEvent(identity.userId, identity.callId, lifecycle);
      }
      const patch = {
        providerCallId: callId,
        ...(blandCallStatus(body, true) ? { status: blandCallStatus(body, true)! } : {}),
        ...(providerStatus ? { providerStatus, terminalReason: providerStatus } : {}),
        ...(normalizeBlandInboundNumber(body.from) ? { phoneNumber: normalizeBlandInboundNumber(body.from)! } : {}),
        ...(safeError(body) ? { error: safeError(body)! } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, 2000) } : {}),
        ...(outcome ? { outcome, outcomeStatus: "completed" as const, followUpStatus: outcome.actionItems.length ? "pending" as const : "scheduled" as const, qa: scorePhoneCallTrace({ direction: call.direction, provider: call.provider, purpose: call.purpose, outcome, timeline: call.timeline }) } : {}),
        ...(Number.isFinite(callLength) && callLength >= 0 ? { callLengthSeconds: Math.min(callLength, 86_400) } : {}),
      };
      const result = await finalizeBlandPhoneCall(identity.userId, identity.callId, patch, blandTranscriptMessages(body, identity.callId));
      if (result === "not_found") {
        await releaseDeliveryLease(deliveryKey, leaseToken).catch(() => false);
        return fail(404, "unknown Bland call");
      }
      const saved = await getPhoneCall(identity.userId, identity.callId);
      if (saved?.outcome && saved.followUpStatus !== "scheduled") {
        try {
          const followUp = await schedulePhoneCallFollowUps(saved, saved.outcome);
          await updatePhoneCall(identity.userId, identity.callId, { followUpTaskIds: followUp.taskIds, followUpStatus: "scheduled", followUpErrorCode: undefined });
        } catch (error) {
          await updatePhoneCall(identity.userId, identity.callId, { followUpStatus: "failed", followUpErrorCode: "follow_up_scheduling_failed" }).catch(() => undefined);
          throw error;
        }
      }
      if (!(await completeDeliveryLease(deliveryKey, leaseToken, DELIVERY_TTL_SECONDS))) return fail(503, "Bland callback lease expired before completion");
      return { status: 200, body: { ok: true, duplicate: result === "already_processed" } };
    }

    const status = blandCallStatus(body, false);
    const providerStatus = blandProviderStatus(body, false);
    if (providerStatus && providerStatusCanAdvance(call.providerStatus, providerStatus)) {
      const lifecycle = blandLifecycleEvent(providerStatus);
      if (lifecycle) await appendPhoneCallEvent(identity.userId, identity.callId, lifecycle);
    }
    if (!status && !call.providerCallId) {
      await updatePhoneCall(identity.userId, identity.callId, { providerCallId: callId, ...(providerStatus ? { providerStatus } : {}) });
    } else {
      await updatePhoneCall(identity.userId, identity.callId, { providerCallId: callId, ...(status ? { status } : {}), ...(providerStatus ? { providerStatus } : {}) });
    }
    if (!(await completeDeliveryLease(deliveryKey, leaseToken, DELIVERY_TTL_SECONDS))) return fail(503, "Bland callback lease expired before completion");
    return { status: 200, body: { ok: true } };
  } catch (error) {
    await releaseDeliveryLease(deliveryKey, leaseToken).catch(() => false);
    throw error;
  }
}

export async function processBlandConsult(input: {
  authorization: string;
  rawBody: string;
  secret: string;
  authorizeQuestion?: (userId: number) => Promise<"allowed" | "rate_limited" | "usage_limit">;
  answerQuestion: (request: { userId: number; callId: string; purpose: string; question: string }) => Promise<string>;
}): Promise<{ status: number; body: { ok: boolean; answer?: string; error?: string } }> {
  const match = input.authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() ?? "";
  const expected = Buffer.from(input.secret);
  const provided = Buffer.from(supplied);
  if (!isValidBlandToolSecret(input.secret) || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const body = parseObject(input.rawBody, MAX_TOOL_BYTES);
  if (!body) return { status: Buffer.byteLength(input.rawBody, "utf8") > MAX_TOOL_BYTES ? 413 : 400, body: { ok: false, error: "invalid request" } };
  const providerId = providerCallId(body);
  const question = typeof body.question === "string" ? body.question.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, 1500) : "";
  if (!providerId || !question) return { status: 400, body: { ok: false, error: "call_id and question are required" } };
  const call = await getBlandPhoneCallByProviderId(providerId);
  if (!call) return { status: 404, body: { ok: false, error: "unknown Bland call" } };
  if (call.status === "ended" || call.status === "failed") return { status: 409, body: { ok: false, error: "call is no longer active" } };
  if (input.authorizeQuestion) {
    const authorization = await input.authorizeQuestion(call.userId);
    if (authorization === "rate_limited") return { status: 200, body: { ok: true, answer: "I can't check that right now, but I'll make sure the owner follows up." } };
    if (authorization === "usage_limit") return { status: 200, body: { ok: true, answer: "I can't access that detail right now, but I'll make sure the owner follows up." } };
  }
  try {
    const answer = (await input.answerQuestion({ userId: call.userId, callId: call.id, purpose: call.purpose, question })).trim().slice(0, 2500);
    return { status: 200, body: { ok: true, answer: answer || "I don't have enough reliable information to answer that just now." } };
  } catch {
    return { status: 200, body: { ok: true, answer: "I can't verify that detail at the moment, but I'll make sure the owner follows up." } };
  }
}
