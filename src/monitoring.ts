import { logger } from "./logger.js";
import { posthog } from "./posthog.js";

type MonitorEvent = "workflow_failure" | "delivery_failure" | "provider_failure" | "redis_failure" | "vector_failure";

const counters: Record<MonitorEvent, number> = {
  workflow_failure: 0,
  delivery_failure: 0,
  provider_failure: 0,
  redis_failure: 0,
  vector_failure: 0,
};

let lastFailureAt: number | undefined;
let lastFailureType: MonitorEvent | undefined;
let lastFailureMessage: string | undefined;
let vectorFailures = 0;
let vectorLastFailureAt: number | undefined;
let vectorLastFailureMessage: string | undefined;
let vectorLastLoggedAt = 0;

export function recordFailure(type: MonitorEvent, error: unknown, context: Record<string, unknown> = {}): void {
  counters[type] += 1;
  lastFailureAt = Date.now();
  lastFailureType = type;
  lastFailureMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  logger.error({ err: error, failureType: type, ...context }, `Chusky ${type}`);
  // Keep the remote event intentionally small and free of prompts, tool
  // arguments, provider responses, IDs, and other user data.
  const properties = Object.fromEntries(Object.entries(context).filter(([key, value]) =>
    ["provider", "workflow", "phase", "reason", "check", "model", "channel", "status", "attempt", "errorClass"].includes(key)
    && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")));
  posthog?.captureException(error, "system", { failure_type: type, ...properties });
}

/** Vector search is deliberately best-effort; aggregate noisy outages while
 * keeping one actionable failure in the normal monitoring stream per minute. */
export function recordVectorFailure(error: unknown, context: Record<string, unknown> = {}): void {
  vectorFailures += 1;
  vectorLastFailureAt = Date.now();
  vectorLastFailureMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (vectorLastFailureAt - vectorLastLoggedAt < 60_000) return;
  vectorLastLoggedAt = vectorLastFailureAt;
  recordFailure("vector_failure", error, { ...context, reason: "vector_degraded" });
}

export function monitoringSnapshot() {
  return {
    counters: { ...counters },
    lastFailure: lastFailureAt ? { at: new Date(lastFailureAt).toISOString(), type: lastFailureType, message: lastFailureMessage } : null,
    vector: { failures: vectorFailures, degraded: vectorLastFailureAt !== undefined && vectorLastFailureAt > Date.now() - 5 * 60_000, lastFailure: vectorLastFailureAt ? { at: new Date(vectorLastFailureAt).toISOString(), message: vectorLastFailureMessage } : null },
  };
}
