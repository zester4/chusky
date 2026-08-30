import { logger } from "./logger.js";

type MonitorEvent = "workflow_failure" | "delivery_failure" | "provider_failure" | "redis_failure";

const counters: Record<MonitorEvent, number> = {
  workflow_failure: 0,
  delivery_failure: 0,
  provider_failure: 0,
  redis_failure: 0,
};

let lastFailureAt: number | undefined;
let lastFailureType: MonitorEvent | undefined;
let lastFailureMessage: string | undefined;

export function recordFailure(type: MonitorEvent, error: unknown, context: Record<string, unknown> = {}): void {
  counters[type] += 1;
  lastFailureAt = Date.now();
  lastFailureType = type;
  lastFailureMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  logger.error({ err: error, failureType: type, ...context }, `Chusky ${type}`);
}

export function monitoringSnapshot() {
  return {
    counters: { ...counters },
    lastFailure: lastFailureAt ? { at: new Date(lastFailureAt).toISOString(), type: lastFailureType, message: lastFailureMessage } : null,
  };
}
