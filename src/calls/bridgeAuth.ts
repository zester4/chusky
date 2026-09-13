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
