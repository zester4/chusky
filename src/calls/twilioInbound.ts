import { randomUUID } from "node:crypto";
import { addFaceTimeCall, listFaceTimeCalls, type FaceTimeCallRecord } from "../store.js";

const E164 = /^\+[1-9]\d{7,14}$/;

export function parseTwilioCallerAllowlist(value: string): string[] {
  const callers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (callers.some((caller) => !E164.test(caller))) throw new Error("TWILIO_INBOUND_ALLOWED_CALLERS must contain only comma-separated E.164 phone numbers");
  return [...new Set(callers)];
}

export function inboundTwilioOwner(value: string): number {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("TWILIO_INBOUND_OWNER_USER_ID must be a positive Telegram user ID");
  return userId;
}

/** Persist a safe inbound call record once. The Twilio Call SID is used only
 * for idempotency and lifecycle correlation; no call audio is retained. */
export async function registerTwilioInboundCall(input: { userId: number; from: string; to: string; callSid: string }): Promise<FaceTimeCallRecord> {
  if (!E164.test(input.from) || !E164.test(input.to) || !/^CA[a-zA-Z0-9]{10,64}$/.test(input.callSid)) throw new Error("Invalid Twilio inbound call data");
  const existing = (await listFaceTimeCalls(input.userId)).find((call) => call.provider === "twilio" && call.direction === "inbound" && call.providerCallId === input.callSid);
  if (existing) return existing;
  const now = Date.now();
  const record: FaceTimeCallRecord = {
    id: `twc_${randomUUID()}`,
    userId: input.userId,
    provider: "twilio",
    direction: "inbound",
    phoneNumber: input.from,
    purpose: "Inbound phone call",
    status: "bridging",
    providerCallId: input.callSid,
    createdAt: now,
    updatedAt: now,
  };
  return addFaceTimeCall(input.userId, record);
}
