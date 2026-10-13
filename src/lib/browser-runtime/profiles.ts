import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const AAD = Buffer.from("chusky-browser-profile:v1", "utf8");

export type BrowserProfileEnvelope = { version: 1; ownerId: number; profileId: string; provider: string; createdAt: number; updatedAt: number; expiresAt?: number; ciphertext: string };

function key(secret: string): Buffer {
  if (!secret.trim()) throw new Error("Browser profile encryption requires a secret");
  return createHash("sha256").update(secret).digest();
}

function owner(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Browser profile owner is invalid"); }
function profile(value: string): void { if (!/^[A-Za-z0-9_-]{8,160}$/.test(value)) throw new Error("Browser profile ID is invalid"); }

/** Encrypts persistent profile state while retaining owner/provider isolation. */
export class EncryptedBrowserProfileStore {
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  namespace(ownerId: number, provider: string, identity: string): string {
    owner(ownerId); if (!provider || provider.length > 40 || !identity || identity.length > 160) throw new Error("Browser profile namespace is invalid");
    return `bp_${createHash("sha256").update(`${ownerId}\0${provider}\0${identity}`).digest("base64url").slice(0, 32)}`;
  }

  seal(ownerId: number, profileId: string, provider: string, state: unknown, ttlMs?: number): BrowserProfileEnvelope {
    owner(ownerId); profile(profileId); if (!provider || provider.length > 40) throw new Error("Browser profile provider is invalid");
    const now = this.now(); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(this.secret), iv); cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    return { version: 1, ownerId, profileId, provider, createdAt: now, updatedAt: now, ...(ttlMs !== undefined ? { expiresAt: now + Math.max(1_000, Math.min(30 * 24 * 60 * 60_000, Math.trunc(ttlMs))) } : {}), ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url") };
  }

  open<T>(ownerId: number, envelope: BrowserProfileEnvelope): T {
    owner(ownerId); if (envelope.version !== 1 || envelope.ownerId !== ownerId) throw new Error("Browser profile is not owned by this account");
    profile(envelope.profileId); if (envelope.expiresAt !== undefined && envelope.expiresAt <= this.now()) throw new Error("Browser profile has expired");
    const raw = Buffer.from(envelope.ciphertext, "base64url"); if (raw.length < 29) throw new Error("Browser profile envelope is invalid");
    const decipher = createDecipheriv("aes-256-gcm", key(this.secret), raw.subarray(0, 12)); decipher.setAAD(AAD); decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
  }
}
