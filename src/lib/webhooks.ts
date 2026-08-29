import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { config } from "../config.js";

const key = () => createHash("sha256").update(config.apiKey).digest();
export function isSafeWebhookUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (isIP(host) === 4) { const [a, b] = host.split(".").map(Number); return !(a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168); }
  if (isIP(host) === 6) return host !== "::1" && !host.startsWith("fc") && !host.startsWith("fd") && !host.startsWith("fe80:");
  return true;
}
export function sealWebhookSecret(secret: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url"); }
export function openWebhookSecret(value: string): string { const raw = Buffer.from(value, "base64url"); const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): { timestamp: string; signature: string } { const value = String(timestamp); return { timestamp: value, signature: `v1=${createHmac("sha256", secret).update(`${value}.${body}`).digest("hex")}` }; }
export async function deliverWebhook(hook: { id: string; url: string; secretCiphertext: string }, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<{ delivered: boolean; status?: number; error?: string }> {
  const body = JSON.stringify({ id: `evt_${randomBytes(12).toString("base64url")}`, createdAt: new Date().toISOString(), data: payload });
  const signed = signWebhook(openWebhookSecret(hook.secretCiphertext), body); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try { const response = await fetchImpl(hook.url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "User-Agent": "Chusky-Webhook/1.0", "X-Chusky-Webhook-Id": hook.id, "X-Chusky-Webhook-Timestamp": signed.timestamp, "X-Chusky-Webhook-Signature": signed.signature }, body, signal: controller.signal }); return response.ok ? { delivered: true, status: response.status } : { delivered: false, status: response.status, error: `HTTP ${response.status}` }; }
  catch (error) { return { delivered: false, error: error instanceof Error ? error.name : "delivery_failed" }; } finally { clearTimeout(timer); }
}
