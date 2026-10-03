import type { BrowserActionStep, BrowserAssertion } from "../browser-runtime/types.js";

export type BrowserRecoveryDecision = {
  retry: boolean;
  reobserve: boolean;
  reason: "stale_observation" | "missing_target" | "ambiguous_target" | "timeout" | "challenge" | "non_retryable";
  nextAction: "observe" | "keyboard_fallback" | "handoff" | "stop";
};

export function classifyBrowserRecovery(error: unknown): BrowserRecoveryDecision {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("stale") || message.includes("fresh accessible") || message.includes("screenshot")) return { retry: true, reobserve: true, reason: "stale_observation", nextAction: "observe" };
  if (message.includes("ambiguous")) return { retry: true, reobserve: true, reason: "ambiguous_target", nextAction: "observe" };
  if (message.includes("not found") || message.includes("missing")) return { retry: true, reobserve: true, reason: "missing_target", nextAction: "observe" };
  if (message.includes("timeout") || message.includes("timed out")) return { retry: true, reobserve: true, reason: "timeout", nextAction: "observe" };
  if (message.includes("captcha") || message.includes("challenge") || message.includes("two_factor")) return { retry: false, reobserve: true, reason: "challenge", nextAction: "handoff" };
  return { retry: false, reobserve: false, reason: "non_retryable", nextAction: "stop" };
}

export function keyboardFallback(step: BrowserActionStep): BrowserActionStep | undefined {
  if (!step.selector || !["click", "invoke", "select_option", "check", "uncheck"].includes(step.action)) return undefined;
  return { ...step, action: "press", key: "Enter" } as BrowserActionStep & { key: string };
}

export function normalizeAssertions(value: unknown): BrowserAssertion[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BrowserAssertion => Boolean(item && typeof item === "object" && typeof (item as BrowserAssertion).kind === "string" && typeof (item as BrowserAssertion).value === "string")).slice(0, 20);
}
