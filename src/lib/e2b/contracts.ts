import { redactBrowserText } from "../../vault/browserObservation.js";
import type { BrowserHandoffRecord } from "../../vault/browserOps.js";
import { E2BBrowserError, E2BBrowserHandoffWaitingError } from "./errors.js";
import type { E2BBrowserAction } from "./types.js";

export const MAX_E2B_PAGE_CONTENT_CHARS = 12_000;
export const DEFAULT_E2B_BROWSER_COMMAND_TIMEOUT_MS = 120_000;
const MIN_E2B_BROWSER_COMMAND_TIMEOUT_MS = 1_000;

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

export function resolveE2BBrowserCommandTimeout(requested: unknown, configuredRequestTimeoutMs: number): number {
  const ceiling = Math.floor(configuredRequestTimeoutMs);
  if (!Number.isSafeInteger(ceiling) || ceiling < MIN_E2B_BROWSER_COMMAND_TIMEOUT_MS) {
    throw new E2BBrowserError("The configured E2B request timeout is invalid");
  }
  if (requested === undefined) return Math.min(DEFAULT_E2B_BROWSER_COMMAND_TIMEOUT_MS, ceiling);
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < MIN_E2B_BROWSER_COMMAND_TIMEOUT_MS) {
    throw new E2BBrowserError(`timeoutMs must be a positive whole number of at least ${MIN_E2B_BROWSER_COMMAND_TIMEOUT_MS}; unbounded timeouts are not supported`);
  }
  return Math.min(requested, ceiling);
}

export function browserHandoffWaitingResult(error: E2BBrowserHandoffWaitingError, action: string) {
  return {
    provider: "e2b",
    action,
    status: "waiting_for_owner",
    handoffId: error.handoffId,
    expiresAt: error.expiresAt,
    next: "The private browser handoff is still waiting for you. Do not retry browser actions. Complete the challenge in the private browser, return, and say continue; then resume the handoff and verify the page before proceeding.",
  };
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
    throw new E2BBrowserHandoffWaitingError(active.id, active.expiresAt);
  }
  let currentOrigin = "";
  try { currentOrigin = currentUrl ? new URL(currentUrl).origin : ""; } catch { /* origin checked below */ }
  if (!["state", "snapshot", "find", "form_inspect", "form_plan"].includes(action) || (active.origin && currentOrigin !== active.origin)) {
    throw new Error("A private browser handoff is awaiting same-origin verification. Inspect only that retained page, then call CHUCK_BROWSER_VERIFY before any further action.");
  }
}
