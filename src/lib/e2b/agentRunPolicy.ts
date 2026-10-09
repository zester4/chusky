export const DEFAULT_BROWSER_AGENT_MAX_STEPS = 20;
export const MAX_BROWSER_AGENT_STEPS = 50;
export const DEFAULT_BROWSER_AGENT_MAX_DURATION_MS = 45_000;
export const MAX_BROWSER_AGENT_DURATION_MS = 120_000;
export const DEFAULT_BROWSER_AGENT_NO_PROGRESS_LIMIT = 2;
export const MAX_BROWSER_AGENT_NO_PROGRESS_LIMIT = 3;

export type BrowserAgentRunLimits = {
  maxSteps: number;
  maxActions: number;
  maxDurationMs: number;
  noProgressLimit: number;
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Browser agent limits must be whole numbers");
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeBrowserAgentRunLimits(input: {
  maxSteps?: unknown;
  maxActions?: unknown;
  maxDurationMs?: unknown;
  noProgressLimit?: unknown;
} = {}): BrowserAgentRunLimits {
  const maxSteps = boundedInteger(input.maxSteps, DEFAULT_BROWSER_AGENT_MAX_STEPS, 1, MAX_BROWSER_AGENT_STEPS);
  const maxActions = boundedInteger(input.maxActions, maxSteps, 1, maxSteps);
  return {
    maxSteps,
    maxActions,
    maxDurationMs: boundedInteger(input.maxDurationMs, DEFAULT_BROWSER_AGENT_MAX_DURATION_MS, 1_000, MAX_BROWSER_AGENT_DURATION_MS),
    noProgressLimit: boundedInteger(input.noProgressLimit, DEFAULT_BROWSER_AGENT_NO_PROGRESS_LIMIT, 1, MAX_BROWSER_AGENT_NO_PROGRESS_LIMIT),
  };
}

/**
 * Build a bounded identity for one proposed step. Dynamic observations and
 * screenshots are intentionally excluded so a retry can be compared safely.
 */
export function browserAgentStepKey(step: Record<string, unknown>): string {
  const selector = step.selector && typeof step.selector === "object" ? step.selector as Record<string, unknown> : undefined;
  return JSON.stringify({
    action: typeof step.action === "string" ? step.action : "",
    selector: selector ? {
      role: selector.role,
      name: selector.name,
      id: selector.id,
      nameAttr: selector.nameAttr,
      placeholder: selector.placeholder,
      autocomplete: selector.autocomplete,
      index: selector.index,
      frameIndex: selector.frameIndex,
      frameUrl: selector.frameUrl,
    } : undefined,
    value: step.value,
    text: step.text,
    key: step.key,
    x: step.x,
    y: step.y,
  });
}

export function browserAgentProgressMarker(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  return JSON.stringify({
    url: result.observedUrl ?? result.url,
    title: result.title,
    pageGeneration: result.pageGeneration,
    accessibilityHash: result.accessibilityHash,
    screenshotHash: result.screenshotHash,
    submitted: result.submitted,
  });
}
