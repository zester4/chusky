import { E2BBrowserError } from "./errors.js";

export const BROWSER_WAIT_LOAD_STATES = ["domcontentloaded", "load", "networkidle"] as const;
export type BrowserWaitLoadState = typeof BROWSER_WAIT_LOAD_STATES[number];

const WAIT_TEXT_FIELDS = ["urlIncludes", "urlExcludes", "titleIncludes", "titleExcludes", "textIncludes", "textExcludes"] as const;

function optionalWaitText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 300 || !value.trim()) throw new E2BBrowserError(`${field} must be 1-300 characters`);
  return value.trim();
}

function waitTimeoutMs(args: Record<string, unknown>): number {
  const raw = args.timeoutSeconds !== undefined
    ? Number(args.timeoutSeconds) * 1_000
    : Number(args.timeoutMs ?? 1_000);
  if (!Number.isFinite(raw) || raw <= 0) throw new E2BBrowserError("Browser wait timeout must be positive");
  return Math.max(50, Math.min(30_000, Math.round(raw)));
}

/**
 * Keep the model-facing wait contract narrow and provider-neutral. The E2B
 * template validates the same fields again because it is a separate runtime.
 */
export function normalizeBrowserWaitRequest(args: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = { action: "wait", timeoutMs: waitTimeoutMs(args) };
  if (typeof args.role === "string" && args.role.trim()) request.role = args.role.trim().slice(0, 40);
  if (typeof args.name === "string" && args.name.trim()) {
    request.name = args.name.trim().slice(0, 300);
    if (["exact", "substring", "regex"].includes(String(args.nameMatch))) request.nameMatch = args.nameMatch;
  }
  if (args.loadState !== undefined) {
    if (!(BROWSER_WAIT_LOAD_STATES as readonly string[]).includes(String(args.loadState))) {
      throw new E2BBrowserError(`loadState must be one of ${BROWSER_WAIT_LOAD_STATES.join(", ")}`);
    }
    request.loadState = args.loadState;
  }
  for (const field of WAIT_TEXT_FIELDS) {
    const value = optionalWaitText(args[field], field);
    if (value !== undefined) request[field] = value;
  }
  return request;
}
