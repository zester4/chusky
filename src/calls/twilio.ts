import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { config } from "../config.js";
import { addFaceTimeCall, updateFaceTimeCall, type FaceTimeCallRecord } from "../store.js";

export interface TwilioCallInput { phoneNumber: string; purpose: string; }
export interface TwilioCallDependencies {
  enabled: boolean; accountSid: string; authToken: string; callerId: string; webhookBaseUrl: string; mediaStreamUrl: string;
  createCall?: (input: { to: string; from: string; url: string; statusCallback: string }) => Promise<{ sid: string }>;
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
function validate(options: TwilioCallDependencies): void {
  if (!options.enabled) throw new Error("Phone calling is disabled. Set TWILIO_VOICE_ENABLED=true after completing Twilio verification and media-bridge setup.");
  if (!options.accountSid || !options.authToken || !options.callerId) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_CALLER_ID are required");
  if (!/^\+[1-9]\d{7,14}$/.test(options.callerId)) throw new Error("TWILIO_CALLER_ID must be an E.164 phone number");
  httpsUrl(options.webhookBaseUrl, "TWILIO_WEBHOOK_BASE_URL");
  if (!/^wss:\/\//i.test(options.mediaStreamUrl)) throw new Error("TWILIO_MEDIA_STREAM_URL must be a WSS URL");
}

/** Creates an outbound Twilio call. Its signed TwiML callback connects the
 * call to Chusky's private Deepgram media bridge. */
export async function startTwilioCallForUser(userId: number, input: TwilioCallInput, options: TwilioCallDependencies = {
  enabled: config.twilioVoiceEnabled, accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken,
  callerId: config.twilioCallerId, webhookBaseUrl: config.twilioWebhookBaseUrl, mediaStreamUrl: config.twilioMediaStreamUrl,
}): Promise<FaceTimeCallRecord> {
  validate(options);
  const phoneNumber = text(input.phoneNumber, "phoneNumber", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("phoneNumber must be an E.164 phone number, for example +14155550123");
  const purpose = text(input.purpose, "purpose");
  const call: FaceTimeCallRecord = { id: `twc_${randomUUID()}`, userId, provider: "twilio", direction: "outbound", phoneNumber, purpose, status: "starting", createdAt: Date.now(), updatedAt: Date.now() };
  await addFaceTimeCall(userId, call);
  const base = httpsUrl(options.webhookBaseUrl, "TWILIO_WEBHOOK_BASE_URL");
  const query = `callId=${encodeURIComponent(call.id)}&userId=${encodeURIComponent(String(userId))}`;
  const url = `${base}/twilio/twiml?${query}`;
  const statusCallback = `${base}/twilio/status?${query}`;
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
    const provider = await create({ to: phoneNumber, from: options.callerId, url, statusCallback });
    return (await updateFaceTimeCall(userId, call.id, { status: "bridging", providerCallId: String(provider.sid).slice(0, 100) }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Twilio call setup failed";
    await updateFaceTimeCall(userId, call.id, { status: "failed", error: message });
    throw new Error(`Phone call could not be started: ${message}`);
  }
}
