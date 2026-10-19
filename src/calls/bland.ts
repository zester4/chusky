import { config } from "../config.js";
import { claimPhoneCallStart, claimVoiceCapacity, enqueueVoiceCallReconciliation, getSession, getVoiceCallProfile, hasVoiceCallOptOut, persistPhoneCallProviderResult, releaseVoiceCapacity, updatePhoneCall, type PhoneCallRecord } from "../store.js";
import { createBlandCallToken, isValidBlandToolSecret } from "./blandSecurity.js";
import { resolveVoiceContinuity, voiceContinuityInstructions } from "./continuity.js";
import { normalizePhoneCallRequestKey } from "./requestKey.js";
import { normalizeVoiceCallProfile, resolveOutboundVoiceCallProfile, voiceCallDialBlockReason, voiceProfileInstructions, type CallProfile, type VoiceCallProfileInput } from "./voiceProfile.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BlandCallInput { phoneNumber: string; purpose: string; profile?: VoiceCallProfileInput; callProfile?: CallProfile; continuityFromCallId?: string; requestKey?: string; }
export interface BlandCallDependencies {
  enabled: boolean;
  apiKey: string;
  webhookUrl: string;
  webhookSecret: string;
  consultToolId: string;
  consultToolSecret: string;
  voice: string;
  fetchImpl?: FetchLike;
}

export function isBlandVoiceConfigured(options: Pick<BlandCallDependencies, "enabled" | "apiKey" | "webhookUrl" | "webhookSecret" | "consultToolId" | "consultToolSecret"> = {
  enabled: config.blandVoiceEnabled, apiKey: config.blandApiKey, webhookUrl: config.blandWebhookUrl, webhookSecret: config.blandWebhookSecret,
  consultToolId: config.blandConsultToolId, consultToolSecret: config.blandConsultToolSecret,
}): boolean {
  if (!options.enabled || !options.apiKey.trim() || options.webhookSecret.trim().length < 32) return false;
  if (!/^TL-[A-Za-z0-9_-]{6,128}$/.test(options.consultToolId) || !isValidBlandToolSecret(options.consultToolSecret) || options.consultToolSecret === options.webhookSecret) return false;
  try {
    const callback = new URL(options.webhookUrl);
    return callback.protocol === "https:" && !callback.username && !callback.password && !callback.hash && !callback.search;
  } catch { return false; }
}

function text(value: unknown, label: string, max: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return result;
}

function validate(options: BlandCallDependencies): void {
  if (!options.enabled) throw new Error("Bland voice is disabled. Set BLAND_VOICE_ENABLED=true to use Bland.");
  if (!options.apiKey) throw new Error("BLAND_API_KEY is required when Bland voice is enabled");
  if (options.webhookSecret.trim().length < 32) throw new Error("BLAND_WEBHOOK_SECRET must contain at least 32 characters");
  if (!/^TL-[A-Za-z0-9_-]{6,128}$/.test(options.consultToolId)) throw new Error("BLAND_CONSULT_TOOL_ID must be the ID returned when provisioning Chusky's Bland custom tool");
  if (!isValidBlandToolSecret(options.consultToolSecret)) throw new Error("BLAND_CONSULT_TOOL_SECRET must be 32-256 URL-safe random characters");
  if (options.consultToolSecret === options.webhookSecret) throw new Error("BLAND_CONSULT_TOOL_SECRET must be distinct from BLAND_WEBHOOK_SECRET");
  let callback: URL;
  try { callback = new URL(options.webhookUrl); } catch { throw new Error("BLAND_WEBHOOK_URL must be an absolute HTTPS URL"); }
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || callback.search) throw new Error("BLAND_WEBHOOK_URL must be an absolute HTTPS URL without credentials, query parameters, or fragments");
}

/** Queue a Bland call while keeping Chusky as the owner of call metadata. */
export async function startBlandCallForUser(userId: number, input: BlandCallInput, options: BlandCallDependencies = {
  enabled: config.blandVoiceEnabled,
  apiKey: config.blandApiKey,
  webhookUrl: config.blandWebhookUrl,
  webhookSecret: config.blandWebhookSecret,
  consultToolId: config.blandConsultToolId,
  consultToolSecret: config.blandConsultToolSecret,
  voice: config.blandVoice,
}): Promise<PhoneCallRecord> {
  validate(options);
  const selectedVoice = ((await getSession(userId)).voicePreferences?.bland?.id ?? options.voice) || "maya";
  const phoneNumber = text(input.phoneNumber, "phoneNumber", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("phoneNumber must be an E.164 phone number, for example +14155550123");
  const purpose = text(input.purpose, "purpose", 2000);
  const profile = resolveOutboundVoiceCallProfile(await getVoiceCallProfile(userId), input.profile);
  const callProfile = input.callProfile === "business" ? "business" : "personal";
  const dialBlockReason = voiceCallDialBlockReason(profile);
  if (dialBlockReason) throw new Error(dialBlockReason);
  if (profile.controls?.optOutEnabled !== false && await hasVoiceCallOptOut(userId, phoneNumber)) throw new Error("This contact has opted out of further calls. No call was placed.");
  const continuity = await resolveVoiceContinuity(userId, input.continuityFromCallId);
  const requestKey = normalizePhoneCallRequestKey(input.requestKey);
  const call: PhoneCallRecord = { id: `blc_${crypto.randomUUID()}`, userId, ...(requestKey ? { requestKey } : {}), provider: "bland", direction: "outbound", callProfile, phoneNumber, purpose, voiceProfile: profile, transcriptRetentionDays: profile.controls?.retentionDays ?? 30, ...(continuity ? { continuity } : {}), status: "starting", providerStatus: "queued", createdAt: Date.now(), updatedAt: Date.now() };
  const claim = await claimPhoneCallStart(userId, call);
  if (!claim.created) return claim.call;
  const claimedCall = claim.call;
  if (!(await claimVoiceCapacity(claimedCall.id, config.twilioVoiceMaxActiveCalls, config.twilioVoiceMaxCallSeconds * 1000))) {
    await updatePhoneCall(userId, claimedCall.id, { status: "failed", providerStatus: "failed", terminalReason: "voice_capacity_full", error: "Voice capacity is temporarily full." });
    await enqueueVoiceCallReconciliation(userId, claimedCall.id, "outcome").catch(() => undefined);
    throw new Error("Voice capacity is temporarily full. No call was placed.");
  }
  let providerCallId: string | undefined;
  try {
    const callbackToken = createBlandCallToken({ userId, callId: claimedCall.id }, options.webhookSecret);
    const callbackUrl = new URL(options.webhookUrl);
    callbackUrl.pathname = `${callbackUrl.pathname.replace(/\/+$/, "")}/${callbackToken}`;
    const response = await (options.fetchImpl ?? fetch)("https://api.bland.ai/v1/calls", {
      method: "POST",
      headers: { Authorization: options.apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        phone_number: phoneNumber,
        task: `${voiceProfileInstructions(profile, "outbound", purpose)}${voiceContinuityInstructions(continuity)} Use the Consult Chusky tool when a question needs the owner's private context, a connected app, or a requested action. Do not use it for ordinary pleasantries. Chusky can carry out routine requested work directly; deletions, financial actions, permission changes, deployment/push actions, and provider-declared high-risk actions retain their approval boundary. Never claim a connected-app action succeeded until Chusky confirms the provider result.`,
        voice: selectedVoice,
        webhook: callbackUrl.toString(),
        webhook_events: ["queue", "call", "latency", "tool"],
        metadata: { chusky_call_id: claimedCall.id, chusky_user_id: String(userId) },
        tools: [options.consultToolId],
      }),
    });
    const payload = await response.json().catch(() => ({})) as { call_id?: string; message?: string; error?: string };
    if (!response.ok || !payload.call_id) throw new Error(`Bland call failed: ${String(payload.message ?? payload.error ?? response.statusText).slice(0, 300)}`);
    providerCallId = payload.call_id.slice(0, 100);
    const persisted = await persistPhoneCallProviderResult(userId, claimedCall, { status: "bridging", providerCallId });
    if (!persisted) throw new Error("Bland accepted the call, but Chusky could not confirm its durable call record. Do not retry this request.");
    await enqueueVoiceCallReconciliation(userId, claimedCall.id, "provider");
    return persisted;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Bland call setup failed";
    if (providerCallId) {
      // The provider side effect is real once Bland returns a call ID. Keep it
      // non-retryable while durable reconciliation catches up; a normal
      // failed state would invite a second outbound call.
      await updatePhoneCall(userId, claimedCall.id, {
        status: "bridging",
        providerStatus: "unknown",
        providerCallId,
        error: "Bland accepted the call, but Chusky is still reconciling its durable call record. Do not retry this request.",
        terminalReason: "provider_accepted_reconciliation_pending",
      }).catch(() => undefined);
      await enqueueVoiceCallReconciliation(userId, claimedCall.id, "provider").catch(() => undefined);
      throw new Error("Bland accepted the call, but Chusky could not confirm its durable call record. Do not retry this request.");
    }
    await releaseVoiceCapacity(claimedCall.id).catch(() => false);
    await updatePhoneCall(userId, claimedCall.id, { status: "failed", providerStatus: "failed", terminalReason: "provider_setup_failed", error: message });
    await enqueueVoiceCallReconciliation(userId, claimedCall.id, "outcome").catch(() => undefined);
    throw new Error(`Bland call could not be started: ${message}`);
  }
}
