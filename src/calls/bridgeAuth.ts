import { createHmac, timingSafeEqual } from "node:crypto";
import { isFluxTtsVoice } from "../voiceSettings.js";

/** Constant-time bearer check for the private Chusky ↔ voice-bridge boundary. */
export function hasBridgeAuthorization(header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Short-lived HMAC ticket passed in a Twilio Stream custom parameter. */
export function createVoiceBridgeTicket(callId: string, userId: number, secret: string, now = Date.now(), ttsModel?: string): string {
  const expiresAt = now + 5 * 60_000;
  if (ttsModel !== undefined && !isFluxTtsVoice(ttsModel)) throw new Error("Invalid Twilio Flux voice");
  const payload = `${callId}.${userId}.${expiresAt}${ttsModel ? `.${ttsModel}` : ""}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return ttsModel ? `${expiresAt}.${ttsModel}.${signature}` : `${expiresAt}.${signature}`;
}

/** Verify the bridge ticket at the root service. The voice bridge uses this
 * after the root has verified the provider signature for the owning Twilio
 * account, so tenant auth tokens never need to leave Chusky. */
export function verifyVoiceBridgeTicket(callId: string, userId: number, ticket: string, secret: string, now = Date.now(), ttsModel?: string): boolean {
  if (!/^twc_[A-Za-z0-9_-]{1,120}$/.test(callId) || !Number.isSafeInteger(userId) || userId <= 0 || !secret || typeof ticket !== "string") return false;
  const parts = ticket.split(".");
  let expiresAt: number;
  let ticketModel: string | undefined;
  let supplied: string;
  if (parts.length === 2) {
    supplied = parts[1] ?? "";
  } else if (parts.length === 3) {
    ticketModel = parts[1];
    supplied = parts[2] ?? "";
    if (!ticketModel || !isFluxTtsVoice(ticketModel) || ticketModel !== ttsModel) return false;
  } else return false;
  expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 6 * 60_000 || !/^[a-f0-9]{64}$/i.test(supplied ?? "")) return false;
  if (parts.length === 2 && ttsModel !== undefined) return false;
  const payload = `${callId}.${userId}.${expiresAt}${ticketModel ? `.${ticketModel}` : ""}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
