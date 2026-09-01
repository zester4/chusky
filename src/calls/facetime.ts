import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { SendblueAdapter, type SendblueFaceTimeCall } from "../channels/sendblue.js";
import { addFaceTimeCall, updateFaceTimeCall, type FaceTimeCallRecord } from "../store.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FaceTimeCallInput { phoneNumber: string; purpose: string; }
export interface FaceTimeBridgeResponse { sessionId?: string; }

export interface FaceTimeCallDependencies {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  fromNumber: string;
  bridgeUrl: string;
  bridgeSecret: string;
  startCall?: (phoneNumber: string, fromNumber: string) => Promise<SendblueFaceTimeCall>;
  fetchImpl?: FetchLike;
}

function safeText(value: unknown, label: string, max = 1000): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return text;
}

function validateConfig(options: FaceTimeCallDependencies): void {
  if (!options.enabled) throw new Error("FaceTime calling is disabled. Set SENDBLUE_FACETIME_ENABLED=true after completing the provider and bridge setup.");
  if (!options.apiKey || !options.apiSecret || !options.fromNumber) throw new Error("Sendblue FaceTime API credentials and SENDBLUE_FACETIME_NUMBER are required");
  if (!/^https:\/\//i.test(options.bridgeUrl) || !options.bridgeSecret) throw new Error("FACETIME_MEDIA_BRIDGE_URL (HTTPS) and FACETIME_MEDIA_BRIDGE_SECRET are required before placing calls");
}

/** Starts the provider call then immediately hands its short-lived Agora token to the bridge. */
export async function startFaceTimeCallForUser(userId: number, input: FaceTimeCallInput, options: FaceTimeCallDependencies = {
  enabled: config.sendblueFaceTimeEnabled,
  apiKey: config.sendblueApiKey,
  apiSecret: config.sendblueApiSecret,
  fromNumber: config.sendblueFaceTimeNumber,
  bridgeUrl: config.faceTimeMediaBridgeUrl,
  bridgeSecret: config.faceTimeMediaBridgeSecret,
}): Promise<FaceTimeCallRecord> {
  validateConfig(options);
  const phoneNumber = safeText(input.phoneNumber, "phoneNumber", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("phoneNumber must be an E.164 phone number, for example +14155550123");
  const purpose = safeText(input.purpose, "purpose");
  const now = Date.now();
  const call: FaceTimeCallRecord = { id: `ftc_${randomUUID()}`, userId, phoneNumber, purpose, status: "starting", createdAt: now, updatedAt: now };
  await addFaceTimeCall(userId, call);
  try {
    const start = options.startCall ?? ((to, from) => new SendblueAdapter(options.apiKey, options.apiSecret, from).startFaceTimeCall(to, from));
    const providerCall = await start(phoneNumber, options.fromNumber);
    const response = await (options.fetchImpl ?? fetch)(options.bridgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.bridgeSecret}`, "X-Chusky-Call-Id": call.id },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ callId: call.id, userId, phoneNumber, purpose, agora: providerCall.agora }),
    });
    const value = await response.json().catch(() => ({})) as FaceTimeBridgeResponse;
    if (!response.ok) throw new Error(`media bridge rejected call handoff (${response.status})`);
    return (await updateFaceTimeCall(userId, call.id, { status: "bridging", bridgeSessionId: typeof value.sessionId === "string" ? value.sessionId.slice(0, 200) : undefined }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "FaceTime call setup failed";
    await updateFaceTimeCall(userId, call.id, { status: "failed", error: message });
    throw new Error(`FaceTime call could not be started: ${message}`);
  }
}
