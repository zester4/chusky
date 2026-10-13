import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isSafeWebhookUrl } from "../webhooks.js";
import { config } from "../../config.js";

const LIVE_VIEW_AAD = Buffer.from("chusky-browser-live-view:v1", "utf8");
const MAX_TICKET_LENGTH = 12_000;

export type BrowserLiveViewMode = "read-only" | "interactive";
export type BrowserLiveViewProvider = "e2b" | "kernel";

export type BrowserLiveViewTicket = {
  version: 1;
  viewerId: string;
  userId: number;
  provider: BrowserLiveViewProvider;
  mode: BrowserLiveViewMode;
  targetUrl: string;
  expiresAt: number;
};

function liveViewKey(): Buffer {
  const secret = config.browserLiveViewSecret.trim() || config.apiKey.trim() || config.webhookSecret.trim();
  if (!secret) throw new Error("Browser live view requires CHUSKY_BROWSER_LIVE_VIEW_SECRET, CHUSKY_PROJECT_KEY, or WEBHOOK_SECRET");
  return createHash("sha256").update(secret).digest();
}

export function browserLiveViewDeliveryConfigured(): boolean {
  if (!config.webhookUrl.trim()) return false;
  const secret = config.browserLiveViewSecret.trim() || config.apiKey.trim() || config.webhookSecret.trim();
  if (!secret) return false;
  try { return isSafeWebhookUrl(new URL(config.webhookUrl)); } catch { return false; }
}

function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", liveViewKey(), iv);
  cipher.setAAD(LIVE_VIEW_AAD);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open(value: string): string | undefined {
  try {
    if (!value || value.length > MAX_TICKET_LENGTH) return undefined;
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", liveViewKey(), raw.subarray(0, 12));
    decipher.setAAD(LIVE_VIEW_AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function validTargetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 8_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validViewerId(value: unknown): value is string {
  return typeof value === "string" && /^lv_[A-Za-z0-9_-]{20,100}$/.test(value);
}

function validProvider(value: unknown): value is BrowserLiveViewProvider {
  return value === "e2b" || value === "kernel";
}

function validMode(value: unknown): value is BrowserLiveViewMode {
  return value === "read-only" || value === "interactive";
}

function parseTicket(value: string, now = Date.now()): BrowserLiveViewTicket | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<BrowserLiveViewTicket>;
    const userId = parsed.userId;
    const expiresAt = parsed.expiresAt;
    if (parsed.version !== 1 || !validViewerId(parsed.viewerId) || typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1
      || !validProvider(parsed.provider) || !validMode(parsed.mode) || !validTargetUrl(parsed.targetUrl)
      || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;
    return {
      version: 1,
      viewerId: parsed.viewerId,
      userId,
      provider: parsed.provider,
      mode: parsed.mode,
      targetUrl: parsed.targetUrl,
      expiresAt,
    };
  } catch {
    return undefined;
  }
}

export function normalizeBrowserLiveViewMode(value: unknown): BrowserLiveViewMode {
  return value === "interactive" ? "interactive" : "read-only";
}

export function createBrowserLiveViewTicket(input: Omit<BrowserLiveViewTicket, "version">, now = Date.now()): string {
  if (!validViewerId(input.viewerId)) throw new Error("Browser live-view viewer ID is invalid");
  if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw new Error("Browser live-view owner is invalid");
  if (!validProvider(input.provider) || !validMode(input.mode)) throw new Error("Browser live-view provider or mode is invalid");
  if (!validTargetUrl(input.targetUrl)) throw new Error("Browser live-view target is invalid");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error("Browser live-view expiry is invalid");
  return seal(JSON.stringify({ version: 1, ...input } satisfies BrowserLiveViewTicket));
}

export function verifyBrowserLiveViewTicket(ticket: string, now = Date.now()): BrowserLiveViewTicket | undefined {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return undefined;
  const opened = open(ticket);
  return opened ? parseTicket(opened, now) : undefined;
}

/** Persist only a second encrypted envelope, never the provider URL or raw bearer token. */
export function sealBrowserLiveViewTicketForStorage(ticket: string): string {
  if (!verifyBrowserLiveViewTicket(ticket, 0)) throw new Error("Cannot persist an invalid browser live-view ticket");
  return seal(ticket);
}

export function openBrowserLiveViewTicketFromStorage(value: string): string | undefined {
  const ticket = open(value);
  return ticket && verifyBrowserLiveViewTicket(ticket) ? ticket : undefined;
}

export function browserLiveViewUrl(ticket: string): string | undefined {
  if (!verifyBrowserLiveViewTicket(ticket)) return undefined;
  if (!browserLiveViewDeliveryConfigured()) return undefined;
  try {
    const base = new URL(config.webhookUrl);
    if (!isSafeWebhookUrl(base)) return undefined;
    return new URL(`/browser/live/${encodeURIComponent(ticket)}`, base).toString();
  } catch {
    return undefined;
  }
}

export function renderBrowserLiveView(ticket: BrowserLiveViewTicket): string {
  const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const readOnly = ticket.mode === "read-only";
  const title = readOnly ? "Watch Chusky browser" : "Chusky browser handoff";
  const description = readOnly
    ? "This is a live, read-only view of the browser Chusky is operating."
    : "This is an interactive handoff. Complete only the user step Chusky requested, then return to the conversation.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #11100f; color: #f5f1eb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: auto 1fr; background: #11100f; }
    header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #39332f; background: #191615; }
    .mark { width: 10px; height: 10px; border-radius: 50%; background: #e05d38; box-shadow: 0 0 0 4px #e05d3833; }
    h1 { font-size: 15px; margin: 0; }
    p { color: #b9aea5; font-size: 12px; margin: 3px 0 0; }
    main { min-height: 0; padding: 12px; }
    iframe { display: block; width: 100%; height: 100%; min-height: 420px; border: 1px solid #39332f; border-radius: 8px; background: #000; ${readOnly ? "pointer-events: none;" : ""} }
  </style>
</head>
<body>
  <header><span class="mark" aria-hidden="true"></span><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div></header>
  <main><iframe title="${escapeHtml(title)}" src="${escapeHtml(ticket.targetUrl)}" referrerpolicy="no-referrer" ${readOnly ? "" : "allow=\"clipboard-read; clipboard-write\""}></iframe></main>
</body>
</html>`;
}

export function browserLiveViewFrameOrigin(ticket: BrowserLiveViewTicket): string {
  return new URL(ticket.targetUrl).origin;
}
