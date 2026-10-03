import { redactBrowserText } from "../../vault/browserObservation.js";
import type { BrowserHandoffRecord } from "../../vault/browserOps.js";
import type { E2BBrowserAction } from "./types.js";

export const MAX_E2B_PAGE_CONTENT_CHARS = 12_000;

export function isTrustedBrowserUrlObservation(provider: unknown, observationMethod: unknown): boolean {
  return observationMethod === "address_bar"
    || (provider === "e2b" && observationMethod === "playwright_page_url");
}

export function normalizeE2BPageContent(value: unknown, maxChars = MAX_E2B_PAGE_CONTENT_CHARS): { text: string; truncated: boolean } {
  const raw = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const bounded = raw.slice(0, Math.max(0, Math.min(MAX_E2B_PAGE_CONTENT_CHARS, maxChars)));
  const scrubbed = bounded
    .replace(/\b(password|passcode|security code|verification code|cvv|cvc)\s*[:=-]\s*\S+/gi, "$1: [redacted]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card number]");
  return { text: redactBrowserText(scrubbed, scrubbed.length), truncated: raw.length > bounded.length };
}

export function normalizeE2BBrowserFileName(value: unknown): string {
  const raw = String(value ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const safe = raw.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+$/, "").slice(0, 120);
  return safe || "browser-download.bin";
}

export function assertE2BBrowserHandoffAllowsAction(
  action: E2BBrowserAction,
  handoffs: BrowserHandoffRecord[],
  currentUrl?: string,
  workspaceId?: string,
  now = Date.now(),
): void {
  const active = handoffs.find((item) => item.workspaceId === workspaceId && item.expiresAt > now && (item.status === "waiting" || item.status === "awaiting_verification"));
  if (!active || ["status", "stop"].includes(action)) return;
  if (active.status === "waiting") {
    throw new Error("A private browser handoff is waiting for the owner. Do not interact with or navigate the page until the owner returns and completes the handoff.");
  }
  let currentOrigin = "";
  try { currentOrigin = currentUrl ? new URL(currentUrl).origin : ""; } catch { /* origin checked below */ }
  if (!["state", "snapshot", "find", "form_inspect", "form_plan"].includes(action) || (active.origin && currentOrigin !== active.origin)) {
    throw new Error("A private browser handoff is awaiting same-origin verification. Inspect only that retained page, then call CHUCK_BROWSER_VERIFY before any further action.");
  }
}
