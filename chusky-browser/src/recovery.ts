import type { BrowserAction, BrowserObservation, MutationClass } from "./contracts.js";

export type RecoveryReason = "stale-observation" | "missing-control" | "ambiguous-control" | "timeout" | "challenge" | "network" | "unknown-mutation" | "non-retryable";
export type RecoveryPlan = {
  reason: RecoveryReason;
  next: "reobserve" | "reobserve-and-retry" | "wait-for-challenge" | "handoff" | "reconcile" | "stop";
  retryAction: boolean;
};

export function classifyFailure(error: unknown, action?: Pick<BrowserAction, "mutation" | "retry">): RecoveryPlan {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("captcha") || message.includes("challenge") || message.includes("press_and_hold") || message.includes("press-and-hold")) {
    return { reason: "challenge", next: "wait-for-challenge", retryAction: false };
  }
  if (message.includes("stale") || message.includes("observation") || message.includes("detached") || message.includes("frame")) {
    return { reason: "stale-observation", next: action?.retry === "reobserve-and-retry" ? "reobserve-and-retry" : "reobserve", retryAction: action?.retry === "reobserve-and-retry" && action.mutation !== "consequential" };
  }
  if (message.includes("ambiguous")) return { reason: "ambiguous-control", next: "reobserve", retryAction: false };
  if (message.includes("not found") || message.includes("missing")) return { reason: "missing-control", next: "reobserve", retryAction: false };
  if (message.includes("timeout") || message.includes("timed out")) return { reason: "timeout", next: "reobserve", retryAction: Boolean(action && isSafeRetryClass(action.mutation) && action.retry !== "never") };
  if (message.includes("network") || message.includes("http/2") || message.includes("navigation")) return { reason: "network", next: "reobserve", retryAction: action?.mutation === "read-only" };
  if (action?.mutation === "consequential") return { reason: "unknown-mutation", next: "reconcile", retryAction: false };
  return { reason: "non-retryable", next: "stop", retryAction: false };
}

function isSafeRetryClass(mutation: MutationClass): boolean {
  return mutation === "read-only" || mutation === "idempotent";
}

export function controlStillUsable(observation: BrowserObservation, target: BrowserAction["target"]): boolean {
  if (!target) return false;
  if (target.observationId !== observation.observationId || target.pageGeneration !== observation.pageGeneration) return false;
  return observation.controls.some((control) => target.nodeId ? control.nodeId === target.nodeId : control.role === target.role && control.name === target.name && control.index === target.index);
}
