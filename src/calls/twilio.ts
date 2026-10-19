import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { config } from "../config.js";
import { appendPhoneCallEvent, claimPhoneCallStart, getPhoneCall, getVoiceCallProfile, listVoiceInboundRoutes, persistPhoneCallProviderResult, updatePhoneCall, type PhoneCallRecord } from "../store.js";
import { resolveVoiceContinuity } from "./continuity.js";
import { normalizePhoneCallRequestKey } from "./requestKey.js";
import { subaccountNumberDependencies } from "./twilioSubaccounts.js";
import { normalizeVoiceCallProfile, resolveOutboundVoiceCallProfile, voiceCallDialBlockReason, type CallProfile, type VoiceCallProfile, type VoiceCallProfileInput } from "./voiceProfile.js";

export interface TwilioCallInput { phoneNumber: string; purpose: string; profile?: VoiceCallProfileInput; callProfile?: CallProfile; continuityFromCallId?: string; requestKey?: string; }
export interface TwilioCallDependencies {
  enabled: boolean; accountSid: string; authToken: string; callerId: string; webhookBaseUrl: string; mediaStreamUrl: string;
  /** Required for outbound calls because the public TwiML route signs the bridge ticket with it. */
  mediaBridgeSecret?: string;
  machineDetection?: "Enable" | "DetectMessageEnd";
  voicemailMessage?: string;
  /** Managed workspace account selected from the owned inbound route. */
  twilioSubaccountId?: string;
  createCall?: (input: { to: string; from: string; url: string; statusCallback: string; machineDetection?: "Enable" | "DetectMessageEnd" }) => Promise<{ sid: string }>;
  updateCall?: (sid: string, input: { status?: "completed"; twiml?: string }) => Promise<void>;
}

export type TwilioCallControlInput =
  | { action: "hangup" }
  | { action: "send_dtmf"; digits: string }
  | { action: "transfer"; phoneNumber: string };

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * Resolve the workspace-owned Twilio account for outbound calls. A managed
 * number is the caller identity the workspace purchased, so it must be paired
 * with the encrypted child-account credentials that own that number. The
 * platform account remains the compatibility fallback for legacy or external
 * routes that do not have a managed number yet.
 */
async function resolveOutboundTwilioDependencies(userId: number, fallback: TwilioCallDependencies, call?: PhoneCallRecord): Promise<TwilioCallDependencies> {
  const routes = await listVoiceInboundRoutes(userId);
  const route = call?.twilioSubaccountId
    ? routes.find((item) => item.provider === "twilio" && item.twilioSubaccountId === call.twilioSubaccountId)
    : routes
      .filter((item) => item.provider === "twilio" && item.source === "managed" && item.twilioSubaccountId && item.capabilities?.voice !== false)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!route?.twilioSubaccountId) {
    if (call?.twilioSubaccountId) throw new Error("The managed phone number for this call is no longer available.");
    return fallback;
  }
  const tenant = await subaccountNumberDependencies(route.twilioSubaccountId);
  return {
    ...fallback,
    accountSid: tenant.accountSid,
    authToken: tenant.authToken,
    callerId: route.phoneNumber,
    webhookBaseUrl: tenant.webhookBaseUrl,
    twilioSubaccountId: route.twilioSubaccountId,
  };
}

export function validateTwilioCallControl(input: TwilioCallControlInput): TwilioCallControlInput {
  if (!input || typeof input !== "object" || !["hangup", "send_dtmf", "transfer"].includes(input.action)) throw new Error("Unsupported Twilio call control action");
  if (input.action === "send_dtmf") {
    if (typeof input.digits !== "string" || !/^[0-9*#,wW]{1,64}$/.test(input.digits)) throw new Error("DTMF digits must contain only 0-9, *, #, comma, or w");
    return { action: "send_dtmf", digits: input.digits };
  }
  if (input.action === "transfer") {
    if (typeof input.phoneNumber !== "string" || !/^\+[1-9]\d{7,14}$/.test(input.phoneNumber.trim())) throw new Error("transfer phoneNumber must be an E.164 phone number");
    return { action: "transfer", phoneNumber: input.phoneNumber.trim() };
  }
  return { action: "hangup" };
}

export function twilioControlTwiML(input: Extract<TwilioCallControlInput, { action: "send_dtmf" | "transfer" }>, callerId: string): string {
  const control = validateTwilioCallControl(input);
  if (control.action === "send_dtmf") return `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${xmlEscape(control.digits)}"/></Response>`;
  if (control.action !== "transfer") throw new Error("Unsupported Twilio TwiML control action");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xmlEscape(callerId)}"><Number>${xmlEscape(control.phoneNumber)}</Number></Dial></Response>`;
}

export function twilioVoicemailTwiML(message: string): string {
  const text = message.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
  if (!text) throw new Error("Voicemail message must not be empty");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(text)}</Say><Hangup/></Response>`;
}

export function twilioUnavailableTwiML(message = "Sorry, this call could not be connected."): string {
  const text = message.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 240) || "Sorry, this call could not be connected.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(text)}</Say><Hangup/></Response>`;
}

/** Apply a bounded owner-authorized control action to an active Twilio call. */
export async function controlTwilioCallForUser(userId: number, callId: string, input: TwilioCallControlInput, options: TwilioCallDependencies = {
  enabled: config.twilioVoiceEnabled, accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken,
  callerId: config.twilioCallerId, webhookBaseUrl: config.twilioWebhookBaseUrl, mediaStreamUrl: config.twilioMediaStreamUrl,
  mediaBridgeSecret: config.twilioMediaBridgeSecret,
}): Promise<PhoneCallRecord> {
  if (!/^twc_[0-9a-f-]{36}$/i.test(callId)) throw new Error("Invalid Twilio call ID");
  const call = await getPhoneCall(userId, callId);
  if (!call || call.provider !== "twilio") throw new Error("Twilio call not found or not owned by you");
  if (!call.providerCallId || !["starting", "bridging", "active"].includes(call.status)) throw new Error("Twilio call is not active");
  options = await resolveOutboundTwilioDependencies(userId, options, call);
  validate(options);
  const control = validateTwilioCallControl(input);
  const update = options.updateCall ?? (async (sid, request) => {
    await twilio(options.accountSid, options.authToken).calls(sid).update(request);
  });
  if (control.action === "hangup") {
    await update(call.providerCallId, { status: "completed" });
    return (await updatePhoneCall(userId, call.id, { status: "ended" }))!;
  }
  if (control.action === "transfer") await appendPhoneCallEvent(userId, call.id, { type: "handoff_requested", summary: "The call requested a human handoff." });
  try {
    await update(call.providerCallId, { twiml: twilioControlTwiML(control, options.callerId) });
    if (control.action === "transfer") await appendPhoneCallEvent(userId, call.id, { type: "handoff_started", summary: "The provider accepted the human handoff request." });
  } catch (error) {
    if (control.action === "transfer") await appendPhoneCallEvent(userId, call.id, { type: "handoff_failed", summary: "The human handoff could not be started." });
    throw error;
  }
  return (await updatePhoneCall(userId, call.id, { status: "active" }))!;
}

function text(value: unknown, label: string, max = 1000): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return result;
}
function httpsUrl(value: string, label: string): string {
  const result = value.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(result)) throw new Error(`${label} must be an HTTPS URL`);
  return result;
}
function validate(options: TwilioCallDependencies, requireBridgeSecret = false): void {
  if (!options.enabled) throw new Error("Phone calling is disabled. Set TWILIO_VOICE_ENABLED=true after completing Twilio verification and media-bridge setup.");
  if (!options.accountSid || !options.authToken || !options.callerId) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_CALLER_ID are required");
  if (!/^\+[1-9]\d{7,14}$/.test(options.callerId)) throw new Error("TWILIO_CALLER_ID must be an E.164 phone number");
  httpsUrl(options.webhookBaseUrl, "TWILIO_WEBHOOK_BASE_URL");
  if (!/^wss:\/\//i.test(options.mediaStreamUrl)) throw new Error("TWILIO_MEDIA_STREAM_URL must be a WSS URL");
  if (requireBridgeSecret && !options.mediaBridgeSecret?.trim()) throw new Error("TWILIO_MEDIA_BRIDGE_SECRET is required for outbound phone calls");
}

export function isTwilioVoiceConfigured(options: Omit<TwilioCallDependencies, "createCall"> = {
  enabled: config.twilioVoiceEnabled, accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken,
  callerId: config.twilioCallerId, webhookBaseUrl: config.twilioWebhookBaseUrl, mediaStreamUrl: config.twilioMediaStreamUrl,
  mediaBridgeSecret: config.twilioMediaBridgeSecret,
}): boolean {
  try { validate(options, true); return true; } catch { return false; }
}

/** Validates the exact user-reviewed arguments before an approval is created. */
export function validateTwilioCallInput(input: TwilioCallInput): { phoneNumber: string; purpose: string; profile: VoiceCallProfile; callProfile: CallProfile } {
  const phoneNumber = text(input.phoneNumber, "phoneNumber", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("phoneNumber must be an E.164 phone number, for example +14155550123");
  return { phoneNumber, purpose: text(input.purpose, "purpose"), profile: normalizeVoiceCallProfile(input.profile), callProfile: input.callProfile === "business" ? "business" : "personal" };
}

/** Creates an outbound Twilio call. Its signed TwiML callback connects the
 * call to Chusky's private Deepgram media bridge. */
export async function startTwilioCallForUser(userId: number, input: TwilioCallInput, options: TwilioCallDependencies = {
  enabled: config.twilioVoiceEnabled, accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken,
  callerId: config.twilioCallerId, webhookBaseUrl: config.twilioWebhookBaseUrl, mediaStreamUrl: config.twilioMediaStreamUrl,
  mediaBridgeSecret: config.twilioMediaBridgeSecret,
  ...(config.twilioVoicemailEnabled ? { machineDetection: "DetectMessageEnd" as const, voicemailMessage: config.twilioVoicemailMessage } : {}),
}): Promise<PhoneCallRecord> {
  options = await resolveOutboundTwilioDependencies(userId, options);
  validate(options, true);
  if (options.voicemailMessage !== undefined && (!options.voicemailMessage.trim() || options.voicemailMessage.length > 500)) throw new Error("voicemailMessage must be 1-500 characters");
  const { phoneNumber, purpose, profile: requestedProfile, callProfile } = validateTwilioCallInput(input);
  const profile = resolveOutboundVoiceCallProfile(await getVoiceCallProfile(userId), requestedProfile);
  const continuity = await resolveVoiceContinuity(userId, input.continuityFromCallId);
  const dialBlockReason = voiceCallDialBlockReason(profile);
  if (dialBlockReason) throw new Error(dialBlockReason);
  const base = httpsUrl(options.webhookBaseUrl, "TWILIO_WEBHOOK_BASE_URL");
  const requestKey = normalizePhoneCallRequestKey(input.requestKey);
  const call: PhoneCallRecord = { id: `twc_${randomUUID()}`, userId, ...(requestKey ? { requestKey } : {}), provider: "twilio", direction: "outbound", callProfile, phoneNumber, purpose, voiceProfile: profile, ...(options.twilioSubaccountId ? { twilioSubaccountId: options.twilioSubaccountId } : {}), ...(continuity ? { continuity } : {}), status: "starting", providerStatus: "queued", createdAt: Date.now(), updatedAt: Date.now() };
  const claim = await claimPhoneCallStart(userId, call);
  if (!claim.created) return claim.call;
  const claimedCall = claim.call;
  const query = `callId=${encodeURIComponent(claimedCall.id)}&userId=${encodeURIComponent(String(userId))}`;
  const url = `${base}/twilio/twiml?${query}`;
  const statusCallback = `${base}/twilio/status?${query}`;
  let providerCallId: string | undefined;
  try {
    const create = options.createCall ?? (async (request) => {
      const result = await twilio(options.accountSid, options.authToken).calls.create({
        ...request,
        method: "POST",
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      return { sid: result.sid };
    });
    const provider = await create({ to: phoneNumber, from: options.callerId, url, statusCallback, ...(options.machineDetection ? { machineDetection: options.machineDetection } : {}) });
    providerCallId = String(provider?.sid ?? "").trim().slice(0, 100);
    if (!providerCallId) throw new Error("Twilio returned no call receipt");
    const persisted = await persistPhoneCallProviderResult(userId, claimedCall, { status: "bridging", providerCallId });
    if (!persisted) throw new Error("Twilio accepted the call, but Chusky could not confirm its durable call record. Do not retry this request.");
    return persisted;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Twilio call setup failed";
    if (providerCallId) {
      // Twilio has already accepted the side effect. A persistence failure is
      // not evidence that the call failed, and marking it failed would make a
      // retry capable of dialing the same person twice. Keep the record in an
      // uncertain, non-retryable state until the provider callback reconciles
      // its lifecycle and tell the caller exactly what happened.
      await updatePhoneCall(userId, claimedCall.id, {
        status: "bridging",
        providerStatus: "unknown",
        providerCallId,
        error: "Twilio accepted the call, but Chusky is still reconciling its durable call record. Do not retry this request.",
        terminalReason: "provider_accepted_reconciliation_pending",
      }).catch(() => undefined);
      throw new Error("Twilio accepted the call, but Chusky could not confirm its durable call record. Do not retry this request.");
    }
    await updatePhoneCall(userId, claimedCall.id, { status: "failed", error: message });
    throw new Error(`Phone call could not be started: ${message}`);
  }
}
