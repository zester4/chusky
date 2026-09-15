import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const RECALL_VISUAL_FRAME_MAX_BYTES = 1_500_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function frameAad(meetingId: string, userId: number, createdAt: number): Buffer {
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("Invalid Recall visual frame scope");
  }
  return Buffer.from(`chusky-recall-visual-v1\0${meetingId}\0${userId}\0${createdAt}`, "utf8");
}

function frameKey(secret: string): Buffer {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Recall visual frame encryption is not configured");
  return createHmac("sha256", secret).update("chusky:recall:visual-frame:key:v1", "utf8").digest();
}

/** Validate the provider's bounded PNG bytes without decoding or retaining pixel data. */
export function validateRecallPngFrame(base64: string): Buffer {
  if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(RECALL_VISUAL_FRAME_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Recall screen frame is not valid bounded base64 PNG data");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 33 || bytes.length > RECALL_VISUAL_FRAME_MAX_BYTES || bytes.toString("base64") !== base64 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Recall screen frame is not a valid bounded PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 1_280 || height > 1_280 || width * height > 1_000_000) throw new Error("Recall screen frame dimensions exceed the supported limit");
  return bytes;
}

/** Encrypt one transient frame for the cross-replica Redis handoff; never persist plaintext media. */
export function sealRecallVisualFrame(input: { meetingId: string; userId: number; base64: string; secret: string; nowMs?: number }): string {
  const bytes = validateRecallPngFrame(input.base64);
  const createdAt = input.nowMs ?? Date.now();
  const aad = frameAad(input.meetingId, input.userId, createdAt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", frameKey(input.secret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return ["v1", String(createdAt), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Decrypt a fresh, owner-scoped frame exactly once after the buffer consumes it. */
export function openRecallVisualFrame(input: { meetingId: string; userId: number; sealed: string; secret: string; nowMs?: number; maxAgeMs?: number }): string {
  const [version, timestamp, ivText, tagText, ciphertextText, extra] = input.sealed.split(".");
  const createdAt = Number(timestamp);
  const now = input.nowMs ?? Date.now();
  const maxAge = input.maxAgeMs ?? 15_000;
  if (version !== "v1" || extra !== undefined || !Number.isSafeInteger(createdAt) || createdAt > now + 2_000 || now - createdAt > maxAge) throw new Error("Recall visual frame expired or malformed");
  const iv = Buffer.from(ivText ?? "", "base64url");
  const tag = Buffer.from(tagText ?? "", "base64url");
  const ciphertext = Buffer.from(ciphertextText ?? "", "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 33 || ciphertext.length > RECALL_VISUAL_FRAME_MAX_BYTES) throw new Error("Recall visual frame envelope is invalid");
  const decipher = createDecipheriv("aes-256-gcm", frameKey(input.secret), iv);
  decipher.setAAD(frameAad(input.meetingId, input.userId, createdAt));
  decipher.setAuthTag(tag);
  const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return validateRecallPngFrame(bytes.toString("base64")).toString("base64");
}
