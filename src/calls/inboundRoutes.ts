import { normalizeVoiceCallProfile, type CallProfile, type VoiceCallProfileInput } from "./voiceProfile.js";
import type { BlandInboundRoute } from "./blandInbound.js";
import type { VoiceInboundRouteRecord } from "../store.js";

const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeInboundPhone(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim().replace(/[\s().-]/g, "") : "";
  return E164.test(raw) ? raw : undefined;
}

function phoneList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of E.164 phone numbers`);
  const values = value.map(normalizeInboundPhone);
  if (values.some((item) => !item)) throw new Error(`${field} must contain only E.164 phone numbers`);
  return [...new Set(values as string[])];
}

function boundedText(value: unknown, field: string, maximum: number, fallback?: string): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
  if (!text && fallback !== undefined) return fallback;
  if (!text) throw new Error(`${field} is required`);
  return text;
}

export function normalizeVoiceInboundRouteInput(input: Record<string, unknown>, userId: number, existing?: VoiceInboundRouteRecord): VoiceInboundRouteRecord {
  const provider = input.provider === "bland" ? "bland" : input.provider === "twilio" ? "twilio" : existing?.provider;
  if (!provider) throw new Error("provider must be twilio or bland");
  const phoneNumber = normalizeInboundPhone(input.phoneNumber ?? existing?.phoneNumber);
  if (!phoneNumber) throw new Error("phoneNumber must be a valid E.164 number");
  const callProfile: CallProfile = input.callProfile === "business" ? "business" : input.callProfile === "personal" ? "personal" : existing?.callProfile ?? "business";
  const allowedCallers = phoneList(input.allowedCallers ?? existing?.allowedCallers, "allowedCallers");
  const verifiedCallers = phoneList(input.verifiedCallers ?? existing?.verifiedCallers, "verifiedCallers");
  if (callProfile === "personal" && allowedCallers.length === 0) throw new Error("Personal inbound lines require at least one allowed caller");
  if (verifiedCallers.some((caller) => !allowedCallers.includes(caller)) && callProfile === "personal") throw new Error("verifiedCallers must be included in allowedCallers for personal lines");
  const rawProfile = input.voiceProfile ?? existing?.voiceProfile ?? {};
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) throw new Error("voiceProfile must be an object");
  const voiceProfile = normalizeVoiceCallProfile({ ...(rawProfile as VoiceCallProfileInput), mode: (rawProfile as VoiceCallProfileInput).mode ?? (callProfile === "business" ? "support" : "general") });
  const providerNumberId = typeof input.providerNumberId === "string" && /^[A-Za-z0-9]{6,80}$/.test(input.providerNumberId.trim())
    ? input.providerNumberId.trim()
    : existing?.providerNumberId;
  const displayName = typeof input.displayName === "string"
    ? input.displayName.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || undefined
    : existing?.displayName;
  const capabilities = input.capabilities && typeof input.capabilities === "object" && !Array.isArray(input.capabilities)
    ? {
      voice: (input.capabilities as Record<string, unknown>).voice !== false,
      sms: (input.capabilities as Record<string, unknown>).sms === true,
      mms: (input.capabilities as Record<string, unknown>).mms === true,
      fax: (input.capabilities as Record<string, unknown>).fax === true,
    }
    : existing?.capabilities;
  return {
    provider,
    phoneNumber,
    userId,
    ...(providerNumberId ? { providerNumberId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(capabilities ? { capabilities } : {}),
    source: providerNumberId ? "managed" : existing?.source ?? "external",
    callProfile,
    purpose: boundedText(input.purpose ?? existing?.purpose, "purpose", 2_000, "Handle an inbound caller request"),
    voiceProfile,
    allowedCallers,
    verifiedCallers,
    updatedAt: Date.now(),
  };
}

export function blandRouteFromRecord(record: VoiceInboundRouteRecord): BlandInboundRoute {
  return {
    phoneNumber: record.phoneNumber,
    userId: record.userId,
    callProfile: record.callProfile,
    voiceProfile: record.voiceProfile,
    purpose: record.purpose,
    allowedCallers: record.allowedCallers,
  };
}

export function twilioRouteCallerAllowed(record: VoiceInboundRouteRecord, from: string): boolean {
  return record.callProfile === "business" || record.allowedCallers.includes(from);
}

