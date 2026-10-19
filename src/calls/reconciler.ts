import twilio from "twilio";
import { config } from "../config.js";
import {
  appendPhoneCallEvent,
  claimVoiceCallReconciliations,
  completeVoiceCallReconciliation,
  enqueueVoiceCallReconciliation,
  getPhoneCall,
  releaseVoiceCapacity,
  retryVoiceCallReconciliation,
  updatePhoneCall,
  type PhoneCallRecord,
} from "../store.js";
import { logger } from "../logger.js";
import { twilioWebhookCredentialsForCall } from "./twilioSubaccounts.js";
import { fallbackPhoneCallOutcome } from "./outcome.js";
import { providerStatusCanAdvance, type VoiceCallEventInput } from "./voiceEvents.js";
import type { VoiceCallReconciliationRecord } from "./reconciliationTypes.js";

const RECONCILIATION_LEASE_MS = 90_000;
const MAX_ATTEMPTS = 50;

type ReconciledProviderStatus = NonNullable<PhoneCallRecord["providerStatus"]>;

function retryAt(record: VoiceCallReconciliationRecord): number {
  const delay = Math.min(5 * 60_000, 2_000 * 2 ** Math.min(8, Math.max(0, record.attempts - 1)));
  return Date.now() + delay;
}

function twilioStatus(value: string, answeredBy?: string): ReconciledProviderStatus | undefined {
  const status = value.trim().toLowerCase();
  if (status === "queued") return "queued";
  if (status === "initiated") return "initiated";
  if (status === "ringing") return "ringing";
  if (status === "in-progress" || status === "answered") return "in-progress";
  if (status === "busy") return "busy";
  if (status === "no-answer") return "no-answer";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "completed") return answeredBy?.toLowerCase().startsWith("machine_") ? "machine" : "completed";
  return undefined;
}

function lifecycleEvent(status: ReconciledProviderStatus): VoiceCallEventInput | undefined {
  switch (status) {
    case "queued": return { type: "call_started", summary: "The provider queued the call." };
    case "initiated": return { type: "call_initiated", summary: "The provider accepted the call and began dialing." };
    case "ringing": return { type: "call_ringing", summary: "The destination is ringing." };
    case "in-progress":
    case "answered": return { type: "call_answered", summary: "The call was answered and the voice bridge is active." };
    case "machine": return { type: "voicemail_detected", summary: "The provider reported that voicemail answered." };
    case "busy": return { type: "call_busy", summary: "The destination was busy." };
    case "no-answer": return { type: "call_no_answer", summary: "The destination did not answer." };
    case "failed": return { type: "call_failed", summary: "The provider reported that the call failed." };
    case "canceled": return { type: "call_cancelled", summary: "The provider cancelled the call." };
    case "completed": return { type: "call_ended", summary: "The provider reported that the call ended normally." };
    default: return undefined;
  }
}

function internalStatus(status: ReconciledProviderStatus): PhoneCallRecord["status"] {
  return ["busy", "no-answer", "failed", "canceled"].includes(status) ? "failed" : ["machine", "completed"].includes(status) ? "ended" : ["in-progress", "answered"].includes(status) ? "active" : "bridging";
}

function terminal(status: ReconciledProviderStatus | undefined): boolean {
  return Boolean(status && ["machine", "busy", "no-answer", "failed", "canceled", "completed"].includes(status));
}

type ReconciliationAction = "completed" | "retried";

async function retry(record: VoiceCallReconciliationRecord, message: string): Promise<ReconciliationAction> {
  if (record.attempts >= MAX_ATTEMPTS) {
    const call = await getPhoneCall(record.userId, record.callId);
    if (call && record.phase === "provider" && !["ended", "failed"].includes(call.status)) {
      await appendPhoneCallEvent(record.userId, record.callId, { type: "call_failed", summary: "The provider status could not be confirmed after repeated reconciliation attempts." }).catch(() => undefined);
      await updatePhoneCall(record.userId, record.callId, { status: "failed", providerStatus: "unknown", terminalReason: "provider_reconciliation_exhausted", error: "The provider status could not be confirmed." }).catch(() => undefined);
    }
    if (call && record.phase === "provider") {
      // A provider timeout is terminal from Chusky's perspective. Release the
      // distributed lease and always create the outcome phase so the dashboard
      // cannot remain in a provider-only limbo.
      await releaseVoiceCapacity(record.callId).catch(() => false);
      if (call.outcomeStatus !== "completed") {
        await enqueueVoiceCallReconciliation(call.userId, call.id, "outcome").catch(() => undefined);
      }
    }
    if (call && record.phase === "outcome" && call.outcomeStatus !== "completed") {
      const outcome = fallbackPhoneCallOutcome();
      await updatePhoneCall(record.userId, record.callId, { outcome, outcomeStatus: "completed", postCallProcessedAt: Date.now(), outcomeErrorCode: "outcome_reconciliation_exhausted", followUpStatus: "scheduled" }).catch(() => undefined);
    }
    await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
    return "completed";
  }
  await retryVoiceCallReconciliation(record.id, record.leaseToken ?? "", retryAt(record), message);
  return "retried";
}

async function reconcileProvider(record: VoiceCallReconciliationRecord, call: PhoneCallRecord): Promise<ReconciliationAction> {
  if (call.outcomeStatus === "completed" || ["ended", "failed"].includes(call.status) && terminal(call.providerStatus)) {
    if (call.status === "ended" || call.status === "failed") {
      await releaseVoiceCapacity(call.id).catch(() => false);
      await enqueueVoiceCallReconciliation(call.userId, call.id, "outcome").catch(() => undefined);
    }
    await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
    return "completed";
  }
  if (call.provider === "bland") {
    // Bland is webhook-driven. Reconciliation still prevents an incomplete
    // local projection from living forever, but it never guesses a provider
    // status or makes another dial.
    return retry(record, "Waiting for the Bland lifecycle webhook.");
  }
  if (!call.providerCallId) {
    return retry(record, "The Twilio Call SID is not available yet.");
  }
  const credentials = await twilioWebhookCredentialsForCall(call);
  if (!credentials) {
    return retry(record, "The Twilio account credentials for this call are unavailable.");
  }
  try {
    const remote = await twilio(credentials.accountSid, credentials.authToken).calls(call.providerCallId).fetch();
    const status = twilioStatus(String(remote.status ?? ""), typeof remote.answeredBy === "string" ? remote.answeredBy : undefined);
    if (!status) {
      return retry(record, `Twilio returned an unsupported status: ${String(remote.status ?? "unknown").slice(0, 80)}.`);
    }
    if (providerStatusCanAdvance(call.providerStatus, status)) {
      const event = lifecycleEvent(status);
      if (event) await appendPhoneCallEvent(call.userId, call.id, event);
    }
    const duration = Number(remote.duration);
    const next = await updatePhoneCall(call.userId, call.id, {
      status: internalStatus(status),
      providerStatus: status,
      providerCallId: call.providerCallId,
      ...(Number.isFinite(duration) && duration >= 0 ? { callLengthSeconds: Math.min(Math.floor(duration), 86_400) } : {}),
      ...(terminal(status) ? { terminalReason: status, ...(status === "failed" || status === "busy" || status === "no-answer" ? { error: `Twilio call ${status}` } : {}) } : {}),
    });
    if (!next) { await completeVoiceCallReconciliation(record.id, record.leaseToken ?? ""); return "completed"; }
    if (terminal(status)) {
      await releaseVoiceCapacity(call.id).catch(() => false);
      await enqueueVoiceCallReconciliation(call.userId, call.id, "outcome").catch(() => undefined);
      await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
      return "completed";
    } else {
      return retry(record, "The Twilio call is still in progress.");
    }
  } catch (error) {
    return retry(record, error instanceof Error ? `Twilio status fetch failed: ${error.message}` : "Twilio status fetch failed.");
  }
}

async function reconcileOutcome(record: VoiceCallReconciliationRecord, call: PhoneCallRecord): Promise<ReconciliationAction> {
  if (call.outcomeStatus === "completed") {
    await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
    return "completed";
  }
  if (call.provider === "bland") {
    if (!["ended", "failed"].includes(call.status) || !terminal(call.providerStatus)) {
      return retry(record, "Waiting for the terminal Bland lifecycle state before finalizing the outcome.");
    }
    // Bland's post-call webhook normally supplies the structured outcome. If
    // that callback was lost, preserve a durable, honest review outcome rather
    // than leaving the call pending forever or inventing a result.
    await updatePhoneCall(call.userId, call.id, {
      outcome: fallbackPhoneCallOutcome(),
      outcomeStatus: "completed",
      postCallProcessedAt: Date.now(),
      outcomeErrorCode: "bland_outcome_reconciliation_exhausted",
      followUpStatus: "scheduled",
    });
    await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
    return "completed";
  }
  if (call.provider !== "twilio" || !["ended", "failed"].includes(call.status)) {
    return retry(record, "Waiting for the terminal provider state before finalizing the outcome.");
  }
  const base = config.twilioWebhookBaseUrl.replace(/\/+$/, "");
  if (!base || !config.twilioMediaBridgeSecret) {
    return retry(record, "The durable outcome endpoint is not configured.");
  }
  const turns = (call.transcript?.turns ?? []).map((turn) => ({ transcript: turn.caller, response: turn.assistant })).slice(-12);
  try {
    const response = await fetch(`${base}/internal/twilio/commit-outcome`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${config.twilioMediaBridgeSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ callId: call.id, userId: call.userId, turns }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return retry(record, `Outcome endpoint returned HTTP ${response.status}.`);
    }
    await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
    return "completed";
  } catch (error) {
    return retry(record, error instanceof Error ? `Outcome persistence failed: ${error.message}` : "Outcome persistence failed.");
  }
}

export async function reconcileVoiceCalls(limit = 20): Promise<{ claimed: number; completed: number; retried: number }> {
  const now = Date.now();
  const records = await claimVoiceCallReconciliations(now, limit, RECONCILIATION_LEASE_MS, `vcr_${Math.random().toString(36).slice(2, 18)}`);
  let completed = 0;
  let retried = 0;
  await Promise.all(records.map(async (record) => {
    try {
      const call = await getPhoneCall(record.userId, record.callId);
      if (!call) {
        await completeVoiceCallReconciliation(record.id, record.leaseToken ?? "");
        completed += 1;
        return;
      }
      const action = record.phase === "provider" ? await reconcileProvider(record, call) : await reconcileOutcome(record, call);
      if (action === "completed") completed += 1;
      else retried += 1;
    } catch (error) {
      logger.warn({ callId: record.callId, phase: record.phase, errorType: error instanceof Error ? error.name : "VoiceReconciliationError" }, "Voice reconciliation item failed");
      await retry(record, error instanceof Error ? error.message : "Voice reconciliation failed").catch(() => undefined);
      retried += 1;
    }
  }));
  return { claimed: records.length, completed, retried };
}

