import { config } from "../config.js";
import { addPhoneCall, getSession, updatePhoneCall, type PhoneCallRecord } from "../store.js";
import { createBlandCallToken, isValidBlandToolSecret } from "./blandSecurity.js";
import { normalizeVoiceCallProfile, voiceProfileInstructions, type VoiceCallProfileInput } from "./voiceProfile.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BlandCallInput { phoneNumber: string; purpose: string; profile?: VoiceCallProfileInput; }
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
  const profile = normalizeVoiceCallProfile(input.profile);
  const call: PhoneCallRecord = { id: `blc_${crypto.randomUUID()}`, userId, provider: "bland", direction: "outbound", phoneNumber, purpose, voiceProfile: profile, status: "starting", createdAt: Date.now(), updatedAt: Date.now() };
  await addPhoneCall(userId, call);
  try {
    const callbackToken = createBlandCallToken({ userId, callId: call.id }, options.webhookSecret);
    const callbackUrl = new URL(options.webhookUrl);
    callbackUrl.pathname = `${callbackUrl.pathname.replace(/\/+$/, "")}/${callbackToken}`;
    const response = await (options.fetchImpl ?? fetch)("https://api.bland.ai/v1/calls", {
      method: "POST",
      headers: { Authorization: options.apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        phone_number: phoneNumber,
        task: `${voiceProfileInstructions(profile, "outbound", purpose)} Use the Consult Chusky tool only when a relevant factual question is not answered by this approved call context; do not use it for ordinary pleasantries.`,
        voice: selectedVoice,
        webhook: callbackUrl.toString(),
        webhook_events: ["queue", "call", "latency", "tool"],
        metadata: { chusky_call_id: call.id, chusky_user_id: String(userId) },
        tools: [options.consultToolId],
      }),
    });
    const payload = await response.json().catch(() => ({})) as { call_id?: string; message?: string; error?: string };
    if (!response.ok || !payload.call_id) throw new Error(`Bland call failed: ${String(payload.message ?? payload.error ?? response.statusText).slice(0, 300)}`);
    return (await updatePhoneCall(userId, call.id, { status: "bridging", providerCallId: payload.call_id.slice(0, 100) }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Bland call setup failed";
    await updatePhoneCall(userId, call.id, { status: "failed", error: message });
    throw new Error(`Bland call could not be started: ${message}`);
  }
}
