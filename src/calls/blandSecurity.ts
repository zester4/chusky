import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export interface BlandCallIdentity {
  userId: number;
  callId: string;
}

interface SealedBlandCallIdentity extends BlandCallIdentity {
  version: 1;
  expiresAt: number;
}

const TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_DOMAIN = "chusky:bland:call-identity:v1\0";

export function isValidBlandToolSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(secret);
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(TOKEN_DOMAIN).update(secret).digest();
}

function validIdentity(value: unknown): value is BlandCallIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<BlandCallIdentity>;
  return Number.isSafeInteger(identity.userId) && Number(identity.userId) > 0
    && typeof identity.callId === "string" && /^blc_[0-9a-f-]{36}$/i.test(identity.callId);
}

/** Encrypt owner/call identity into an opaque, short-lived callback capability. */
export function createBlandCallToken(identity: BlandCallIdentity, secret: string, nowMs = Date.now()): string {
  if (!validIdentity(identity)) throw new Error("Invalid Bland call identity");
  if (secret.trim().length < 32) throw new Error("BLAND_WEBHOOK_SECRET must contain at least 32 characters");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const payload: SealedBlandCallIdentity = { ...identity, version: 1, expiresAt: nowMs + TOKEN_LIFETIME_MS };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/** Recover the owner/call identity without placing account IDs in callback URLs. */
export function readBlandCallToken(token: string, secret: string, nowMs = Date.now()): BlandCallIdentity | undefined {
  if (secret.trim().length < 32 || token.length > 512 || !/^v1\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
  try {
    const encoded = token.slice(3);
    const bytes = Buffer.from(encoded, "base64url");
    // Node's base64url decoder accepts non-canonical encodings (for example,
    // changing unused trailing bits). Require a canonical round trip so an
    // altered token cannot alias a valid capability.
    if (bytes.toString("base64url") !== encoded) return undefined;
    if (bytes.length < 29 || bytes.length > 384) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    const value = JSON.parse(plaintext) as Partial<SealedBlandCallIdentity>;
    if (value.version !== 1 || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= nowMs || !validIdentity(value)) return undefined;
    return { userId: value.userId!, callId: value.callId! };
  } catch {
    return undefined;
  }
}

/** Bland signs the exact raw request bytes with HMAC-SHA256 and sends hex. */
export function verifyBlandWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  if (secret.trim().length < 32 || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
