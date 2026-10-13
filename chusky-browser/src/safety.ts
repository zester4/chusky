import type { BrowserAction, BrowserPolicy } from "./contracts.js";

const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"]);

export function assertSafeNavigationTarget(rawUrl: string, policy: Pick<BrowserPolicy, "allowedOrigins">): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("browser target must be a valid URL"); }
  if (url.protocol !== "https:") throw new Error("browser target must use HTTPS");
  if (PRIVATE_HOSTS.has(url.hostname.toLowerCase()) || /^169\.254\./.test(url.hostname) || /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname)) {
    throw new Error("browser target is private or reserved");
  }
  if (policy.allowedOrigins.length && !policy.allowedOrigins.includes(url.origin)) throw new Error("browser target is outside the task origin policy");
  return url;
}

export function actionRequiresApproval(action: BrowserAction): boolean {
  if (action.mutation === "consequential") return true;
  return action.kind === "upload";
}

export function defaultBrowserPolicy(overrides: Partial<BrowserPolicy> = {}): BrowserPolicy {
  return {
    allowedOrigins: [],
    maxActions: 24,
    maxDurationMs: 120_000,
    noProgressLimit: 3,
    defaultScreenshot: "thumbnail",
    requireHandoffForChallenges: true,
    ...overrides,
  };
}
