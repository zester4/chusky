import { randomUUID } from "node:crypto";
import { addPhoneCall, listPhoneCalls, type PhoneCallRecord } from "../store.js";
import { parseVoiceCallProfileJson, type CallProfile, type VoiceCallProfile } from "./voiceProfile.js";

const E164 = /^\+[1-9]\d{7,14}$/;

export function parseTwilioCallerAllowlist(value: string): string[] {
  const callers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (callers.some((caller) => !E164.test(caller))) throw new Error("TWILIO_INBOUND_ALLOWED_CALLERS must contain only comma-separated E.164 phone numbers");
  return [...new Set(callers)];
}

/** Personal lines are private and require an allowlist. Business lines are
 * public by design; their caller remains unverified until a separate
 * verified-callers policy matches and their tools are still call-scoped. */
export function twilioInboundCallerAllowed(callProfile: CallProfile, allowedCallers: string[], from: string): boolean {
  return callProfile === "business" || allowedCallers.includes(from);
}

export function inboundTwilioOwner(value: string): number {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("TWILIO_INBOUND_OWNER_USER_ID must be a positive Telegram user ID");
  return userId;
}

export function parseTwilioInboundRoutes(value: string): Map<string, number> {
  const routes = new Map<string, number>();
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [phoneNumber, owner] = entry.split("=", 2).map((item) => item?.trim() ?? "");
    if (!E164.test(phoneNumber)) throw new Error("TWILIO_INBOUND_ROUTES must map E.164 numbers to positive owner IDs");
    const userId = Number(owner);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("TWILIO_INBOUND_ROUTES must map E.164 numbers to positive owner IDs");
    routes.set(phoneNumber, userId);
  }
  return routes;
}

export function inboundTwilioOwnerForNumber(to: string, fallbackOwner: string, routes: string): number {
  if (!E164.test(to)) throw new Error("Invalid Twilio inbound destination");
  return parseTwilioInboundRoutes(routes).get(to) ?? inboundTwilioOwner(fallbackOwner);
}

/** Parse the owner-configured inbound representative profile. Invalid JSON is
 * rejected instead of silently falling back to Chusky, because the fallback
 * could represent the wrong business or omit the intended tool boundary. */
export function parseTwilioInboundVoiceProfile(value: string, callProfile: CallProfile): VoiceCallProfile {
  try { return parseVoiceCallProfileJson(value, callProfile === "business" ? "support" : "general"); }
  catch (error) { throw new Error(error instanceof Error ? `TWILIO_INBOUND_VOICE_PROFILE: ${error.message}` : "TWILIO_INBOUND_VOICE_PROFILE is invalid"); }
}

/** Persist a safe inbound call record once. The Twilio Call SID is used only
 * for idempotency and lifecycle correlation; no call audio is retained. */
export async function registerTwilioInboundCall(input: { userId: number; from: string; to: string; callSid: string; callProfile?: CallProfile; voiceProfile?: VoiceCallProfile; verification?: "public" | "identified" | "verified"; twilioSubaccountId?: string }): Promise<PhoneCallRecord> {
  if (!E164.test(input.from) || !E164.test(input.to) || !/^CA[a-zA-Z0-9]{10,64}$/.test(input.callSid)) throw new Error("Invalid Twilio inbound call data");
  const existing = (await listPhoneCalls(input.userId)).find((call) => call.provider === "twilio" && call.direction === "inbound" && call.providerCallId === input.callSid);
  if (existing) return existing;
  const now = Date.now();
  const record: PhoneCallRecord = {
    id: `twc_${randomUUID()}`,
    userId: input.userId,
    provider: "twilio",
    direction: "inbound",
    callProfile: input.callProfile === "business" ? "business" : "personal",
    callVerification: input.callProfile === "business" ? (input.verification === "verified" ? "verified" : "identified") : "verified",
    phoneNumber: input.from,
    purpose: "Inbound phone call",
    ...(input.voiceProfile ? { voiceProfile: input.voiceProfile } : {}),
    status: "bridging",
    providerStatus: "initiated",
    providerCallId: input.callSid,
    ...(input.twilioSubaccountId ? { twilioSubaccountId: input.twilioSubaccountId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return addPhoneCall(input.userId, record);
}
