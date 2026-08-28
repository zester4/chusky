import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Keytar = { getPassword(service: string, account: string): Promise<string | null>; setPassword(service: string, account: string, password: string): Promise<void>; deletePassword(service: string, account: string): Promise<boolean> };
const loadModule = createRequire(__filename);
const SERVICE = "Chusky CLI";
let keytar: Keytar | undefined;
try { keytar = loadModule("keytar") as Keytar; } catch { keytar = undefined; }

function fallbackKey(): Buffer | undefined {
  const secret = process.env.CHUSKY_CLI_SECRET;
  return secret ? createHash("sha256").update(secret).digest() : undefined;
}

function secretPath(configPath: string): string { return join(dirname(configPath), "token.enc"); }

export async function loadCliSecret(configPath: string, account: string): Promise<string | undefined> {
  if (keytar) return (await keytar.getPassword(SERVICE, account)) || undefined;
  const key = fallbackKey();
  if (!key) return undefined;
  try {
    const payload = JSON.parse(await readFile(secretPath(configPath), "utf8")) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
  } catch { return undefined; }
}

export async function saveCliSecret(configPath: string, account: string, value: string): Promise<boolean> {
  if (keytar) { await keytar.setPassword(SERVICE, account, value); return true; }
  const key = fallbackKey();
  if (!key) return false;
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(secretPath(configPath), JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { encoding: "utf8", mode: 0o600 });
  try { await chmod(secretPath(configPath), 0o600); } catch { /* Windows ACLs are managed by the profile */ }
  return true;
}

export async function deleteCliSecret(configPath: string, account: string): Promise<void> {
  if (keytar) { await keytar.deletePassword(SERVICE, account); return; }
  try { await unlink(secretPath(configPath)); } catch { /* already absent */ }
}

export function cliSecretBackend(): "keytar" | "encrypted-file" | "legacy-file" {
  return keytar ? "keytar" : fallbackKey() ? "encrypted-file" : "legacy-file";
}
