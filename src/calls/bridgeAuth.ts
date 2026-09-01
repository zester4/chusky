import { timingSafeEqual } from "node:crypto";

/** Constant-time bearer check for the private Chusky ↔ voice-bridge boundary. */
export function hasBridgeAuthorization(header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
