import type { ScreenshotMode, ScreenshotReason } from "./contracts.js";

export type VisualBudget = {
  maxCaptures: number;
  maxBytes: number;
  captures: number;
  bytes: number;
};

export type VisualRequest = {
  reason: ScreenshotReason;
  changed?: boolean;
  ambiguous?: boolean;
  challenge?: boolean;
  geometry?: boolean;
  userRequested?: boolean;
  estimatedBytes?: number;
};

export type VisualDecision = {
  mode: ScreenshotMode;
  allowed: boolean;
  reason: ScreenshotReason;
  rationale: string;
};

export function chooseVisualCapture(request: VisualRequest, budget: VisualBudget): VisualDecision {
  const estimatedBytes = request.estimatedBytes ?? 16_384;
  const escalated = Boolean(request.ambiguous || request.challenge || request.geometry || request.userRequested);
  const mode: ScreenshotMode = escalated ? (request.geometry ? "region" : "viewport") : request.changed === false ? "none" : "thumbnail";

  if (mode === "none") return { mode, allowed: true, reason: request.reason, rationale: "structured state did not change" };
  if (budget.captures >= budget.maxCaptures || budget.bytes + estimatedBytes > budget.maxBytes) {
    return { mode: "none", allowed: false, reason: request.reason, rationale: "visual evidence budget exhausted" };
  }
  return { mode, allowed: true, reason: request.reason, rationale: escalated ? "visual ambiguity or proof requires escalation" : "cheap change-detection capture" };
}

export function recordVisualCapture(budget: VisualBudget, bytes: number): VisualBudget {
  return { ...budget, captures: budget.captures + 1, bytes: budget.bytes + Math.max(0, bytes) };
}
