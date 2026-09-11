import { config } from "../config.js";
import { addFaceTimeCall, updateFaceTimeCall, type FaceTimeCallRecord } from "../store.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BlandCallInput { phoneNumber: string; purpose: string; context?: string; }
export interface BlandCallDependencies {
  enabled: boolean;
  apiKey: string;
  webhookUrl: string;
  voice: string;
  fetchImpl?: FetchLike;
}

function text(value: unknown, label: string, max: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return result;
}

function validate(options: BlandCallDependencies): void {
  if (!options.enabled) throw new Error("Bland voice is disabled. Set BLAND_VOICE_ENABLED=true to use Bland.");
  if (!options.apiKey) throw new Error("BLAND_API_KEY is required when Bland voice is enabled");
  if (!/^https:\/\//i.test(options.webhookUrl)) throw new Error("BLAND_WEBHOOK_URL must be an HTTPS URL");
}

/** Queue a Bland call while keeping Chusky as the owner of call metadata. */
export async function startBlandCallForUser(userId: number, input: BlandCallInput, options: BlandCallDependencies = {
  enabled: config.blandVoiceEnabled,
  apiKey: config.blandApiKey,
  webhookUrl: config.blandWebhookUrl,
  voice: config.blandVoice,
}): Promise<FaceTimeCallRecord> {
  validate(options);
  const phoneNumber = text(input.phoneNumber, "phoneNumber", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("phoneNumber must be an E.164 phone number, for example +14155550123");
  const purpose = text(input.purpose, "purpose", 2000);
  const call: FaceTimeCallRecord = { id: `blc_${crypto.randomUUID()}`, userId, provider: "bland", direction: "outbound", phoneNumber, purpose, status: "starting", createdAt: Date.now(), updatedAt: Date.now() };
  await addFaceTimeCall(userId, call);
  try {
    const response = await (options.fetchImpl ?? fetch)("https://api.bland.ai/v1/calls", {
      method: "POST",
      headers: { Authorization: options.apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        phone_number: phoneNumber,
        task: `You are calling on behalf of Chusky. Purpose: ${purpose}. Be concise, natural, and professional. Do not claim an action is complete unless it actually is. Context from Chusky: ${(input.context ?? "").slice(0, 6000)}`,
        voice: options.voice || "maya",
        webhook: options.webhookUrl,
        webhook_events: ["queue", "call", "latency", "tool"],
        metadata: { chusky_call_id: call.id, chusky_user_id: String(userId) },
      }),
    });
    const payload = await response.json().catch(() => ({})) as { call_id?: string; message?: string; error?: string };
    if (!response.ok || !payload.call_id) throw new Error(`Bland call failed: ${String(payload.message ?? payload.error ?? response.statusText).slice(0, 300)}`);
    return (await updateFaceTimeCall(userId, call.id, { status: "bridging", providerCallId: payload.call_id.slice(0, 100) }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Bland call setup failed";
    await updateFaceTimeCall(userId, call.id, { status: "failed", error: message });
    throw new Error(`Bland call could not be started: ${message}`);
  }
}
