import { createHash } from "node:crypto";
import { addPhoneCall, getBlandPhoneCallByProviderId, getPhoneCall, updatePhoneCall, type PhoneCallRecord } from "../store.js";
import { isValidBlandToolSecret } from "./blandSecurity.js";
import { defaultBusinessVoiceProfile, voiceRecordingBlockReason, type CallProfile, type VoiceCallProfile } from "./voiceProfile.js";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface BlandInboundRoute {
  phoneNumber: string;
  userId: number;
  callProfile: CallProfile;
  voiceProfile?: VoiceCallProfile;
  purpose: string;
  allowedCallers: string[];
}

export function isBlandInboundConfigured(options: {
  enabled: boolean;
  apiKey: string;
  inboundWebhookUrl: string;
  routes: string;
  hasDurableRoutes?: boolean;
  allowedCallers?: string;
  webhookSecret: string;
  consultToolId: string;
  consultToolSecret: string;
}): boolean {
  if (!options.enabled) return true;
  if (!options.apiKey.trim() || options.webhookSecret.trim().length < 32 || !/^TL-[A-Za-z0-9_-]{6,128}$/.test(options.consultToolId) || !isValidBlandToolSecret(options.consultToolSecret)) return false;
  try {
    const url = new URL(options.inboundWebhookUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
    parseBlandInboundAllowedCallers(options.allowedCallers ?? "");
    return Boolean(options.hasDurableRoutes) || parseBlandInboundRoutes(options.routes).size > 0;
  } catch {
    return false;
  }
}

export function normalizeBlandInboundNumber(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim().replace(/[\s()-]/g, "") : "";
  const candidate = raw.startsWith("+") ? raw : raw ? `+${raw}` : "";
  return E164.test(candidate) ? candidate : undefined;
}

export function parseBlandInboundAllowedCallers(value: string): string[] {
  const callers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (callers.some((caller) => !E164.test(caller))) throw new Error("BLAND_INBOUND_ALLOWED_CALLERS must contain only comma-separated E.164 phone numbers");
  return [...new Set(callers)];
}

export function parseBlandInboundRoutes(value: string, options: { callProfile?: CallProfile; voiceProfile?: VoiceCallProfile; purpose?: string; allowedCallers?: string[] } = {}): Map<string, BlandInboundRoute> {
  const routes = new Map<string, BlandInboundRoute>();
  const callProfile = options.callProfile === "business" ? "business" : "personal";
  const purpose = (options.purpose ?? "Handle an inbound caller request").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000) || "Handle an inbound caller request";
  const allowedCallers = [...new Set(options.allowedCallers ?? [])];
  const voiceProfile = options.voiceProfile ?? (callProfile === "business" ? defaultBusinessVoiceProfile() : undefined);
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [phoneNumber, owner] = entry.split("=", 2).map((item) => item?.trim() ?? "");
    if (!E164.test(phoneNumber)) throw new Error("BLAND_INBOUND_ROUTES must map E.164 numbers to positive owner IDs");
    const userId = Number(owner);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("BLAND_INBOUND_ROUTES must map E.164 numbers to positive owner IDs");
    routes.set(phoneNumber, { phoneNumber, userId, callProfile, ...(voiceProfile ? { voiceProfile } : {}), purpose, allowedCallers });
  }
  return routes;
}

function payloadObject(rawBody: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(rawBody) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a signed Bland payload to the configured inbound number. */
export function resolveBlandInboundRoute(rawBody: string, routes: Map<string, BlandInboundRoute>, pathPhoneNumber?: string): BlandInboundRoute | undefined {
  const body = payloadObject(rawBody);
  if (!body || body.inbound === false) return undefined;
  const variables = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables) ? body.variables as Record<string, unknown> : {};
  const bodyNumber = normalizeBlandInboundNumber(body.to ?? variables.to ?? variables.phone_number);
  const pathNumber = normalizeBlandInboundNumber(pathPhoneNumber);
  if (pathPhoneNumber && !pathNumber) return undefined;
  if (pathNumber && bodyNumber && pathNumber !== bodyNumber) return undefined;
  return routes.get(pathNumber ?? bodyNumber ?? "");
}

function deterministicCallId(userId: number, providerCallId: string): string {
  const digest = createHash("sha256").update(`bland-inbound:${userId}:${providerCallId}`).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${digest.slice(18, 20)}-${digest.slice(20, 32)}`;
  return `blc_${uuid}`;
}

function safeCaller(value: unknown): string | undefined {
  const caller = normalizeBlandInboundNumber(value);
  return caller;
}

/** Register the first durable account-scoped record for an inbound Bland call. */
export async function registerBlandInboundCall(input: {
  route: BlandInboundRoute;
  providerCallId: string;
  from?: unknown;
}): Promise<PhoneCallRecord> {
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(input.providerCallId)) throw new Error("Invalid Bland inbound provider call ID");
  const voiceProfile = input.route.voiceProfile ?? (input.route.callProfile === "business" ? defaultBusinessVoiceProfile() : undefined);
  const recordingBlock = voiceProfile ? voiceRecordingBlockReason(voiceProfile) : undefined;
  if (recordingBlock) throw new Error(recordingBlock);
  const existingByProvider = await getBlandPhoneCallByProviderId(input.providerCallId);
  if (existingByProvider) {
    if (existingByProvider.userId !== input.route.userId) throw new Error("Bland inbound call is linked to another owner");
    return existingByProvider;
  }

  const caller = safeCaller(input.from);
  const callId = deterministicCallId(input.route.userId, input.providerCallId);
  const existing = await getPhoneCall(input.route.userId, callId);
  if (existing) return existing;
  const now = Date.now();
  const verified = Boolean(caller && input.route.allowedCallers.includes(caller));
  const record: PhoneCallRecord = {
    id: callId,
    userId: input.route.userId,
    provider: "bland",
    direction: "inbound",
    callProfile: input.route.callProfile,
    ...(voiceProfile ? { voiceProfile } : {}),
    transcriptRetentionDays: voiceProfile?.controls?.retentionDays ?? 30,
    callVerification: verified ? "verified" : input.route.callProfile === "business" ? "identified" : "public",
    // Bland's live event payload may omit `from`; retain the configured line
    // until the post-call payload provides the caller number.
    phoneNumber: caller ?? input.route.phoneNumber,
    purpose: input.route.purpose,
    status: "bridging",
    providerCallId: input.providerCallId,
    createdAt: now,
    updatedAt: now,
  };
  const added = await addPhoneCall(input.route.userId, record);
  if (added.providerCallId === input.providerCallId) return added;
  return (await updatePhoneCall(input.route.userId, callId, { providerCallId: input.providerCallId })) ?? added;
}
