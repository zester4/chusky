export type RetailerFailureClass =
  | "challenge"
  | "timeout"
  | "browser_closed"
  | "navigation_error"
  | "action_error"
  | "unknown";

export function classifyRetailerFailure(value: unknown): RetailerFailureClass {
  const text = String(value instanceof Error ? value.message : value).toLowerCase();
  if (/captcha|recaptcha|hcaptcha|cloudflare|verify you are human|challenge|two[- ]factor/.test(text)) return "challenge";
  if (/deadline_exceeded|timed out|timeout|exceeding .*timeout/.test(text)) return "timeout";
  if (/target page, context or browser has been closed|browser has been closed|page has been closed|target closed/.test(text)) return "browser_closed";
  if (/net::|navigation|goto|dns|connection|err_failed/.test(text)) return "navigation_error";
  if (/locator|selector|click|fill|select|checkbox|variant|cart/.test(text)) return "action_error";
  return "unknown";
}

export function isPurchaseControlLabel(value: unknown): boolean {
  return /(^|\b)(place (?:my )?order|submit order|buy now|pay now|complete (?:the )?purchase|confirm (?:and )?(?:pay|purchase|order)|submit payment|finish (?:the )?order|order now|proceed to (?:place )?(?:the )?(?:order|payment|purchase)|continue to payment)(\b|$)/i.test(String(value ?? ""));
}

export function pageLooksUsable(value: { url?: unknown; title?: unknown; pageContent?: unknown }): boolean {
  const url = String(value.url ?? "");
  const text = `${url} ${String(value.title ?? "")} ${String(value.pageContent ?? "")}`.toLowerCase();
  return Boolean(url) && !/^chrome-error:|\/blocked(?:[/?#]|$)/i.test(url) && !/(robot or human|access denied|request blocked)/i.test(text);
}

export function hasCartSignal(value: { url?: unknown; title?: unknown; pageContent?: unknown }): boolean {
  const text = `${String(value.url ?? "")} ${String(value.title ?? "")} ${String(value.pageContent ?? "")}`.toLowerCase();
  return /(cart|bag|added to|in your cart|quantity|remove from cart)/.test(text);
}

export function phaseTimeoutMs(phase: "startup" | "navigation" | "action" | "handoff"): number {
  const defaults = { startup: 120_000, navigation: 150_000, action: 90_000, handoff: 60_000 };
  const envName = `E2B_LIVE_${phase.toUpperCase()}_TIMEOUT_MS`;
  const configured = Number(process.env[envName]);
  return Number.isInteger(configured) && configured > 0 ? Math.max(30_000, Math.min(240_000, configured)) : defaults[phase];
}
