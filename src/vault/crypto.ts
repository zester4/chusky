import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedCredential = {
  ciphertext: string;
  dataIv: string;
  dataAuthTag: string;
  wrappedKey: string;
  keyIv: string;
  keyAuthTag: string;
};

function keyFromBase64(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error(`${name} must be a base64url-encoded 32-byte key`);
  return key;
}

function seal(plaintext: Buffer, key: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return { ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), iv, tag: cipher.getAuthTag() };
}

function open(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Envelope encryption: every credential has a random data key; only that key is wrapped by VAULT_MASTER_KEY. */
export function encryptCredential(value: Record<string, unknown>, masterKeyValue: string): EncryptedCredential {
  const masterKey = keyFromBase64(masterKeyValue, "VAULT_MASTER_KEY");
  const dataKey = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  try {
    const data = seal(plaintext, dataKey);
    const wrapped = seal(dataKey, masterKey);
    return {
      ciphertext: data.ciphertext.toString("base64url"), dataIv: data.iv.toString("base64url"), dataAuthTag: data.tag.toString("base64url"),
      wrappedKey: wrapped.ciphertext.toString("base64url"), keyIv: wrapped.iv.toString("base64url"), keyAuthTag: wrapped.tag.toString("base64url"),
    };
  } finally { plaintext.fill(0); dataKey.fill(0); masterKey.fill(0); }
}

export function decryptCredential<T extends Record<string, unknown>>(encrypted: EncryptedCredential, masterKeyValue: string): T {
  const masterKey = keyFromBase64(masterKeyValue, "VAULT_MASTER_KEY");
  let dataKey: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    dataKey = open(Buffer.from(encrypted.wrappedKey, "base64url"), Buffer.from(encrypted.keyIv, "base64url"), Buffer.from(encrypted.keyAuthTag, "base64url"), masterKey);
    plaintext = open(Buffer.from(encrypted.ciphertext, "base64url"), Buffer.from(encrypted.dataIv, "base64url"), Buffer.from(encrypted.dataAuthTag, "base64url"), dataKey);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } finally { masterKey.fill(0); dataKey?.fill(0); plaintext?.fill(0); }
}
