import type { TaskWaitRequest } from "./types.js";

export const TASK_WAIT_MIN_SECONDS = 60;
export const TASK_WAIT_MAX_SECONDS = 7 * 24 * 60 * 60;

function bounded(value: unknown, label: string, maxCharacters: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxCharacters) throw new Error(`${label} must be 1-${maxCharacters} characters`);
  return result;
}

/** Validate and normalize the model's internal durable continuation request. */
export function createTaskWaitRequest(args: Record<string, unknown>, now = Date.now()): TaskWaitRequest {
  const hasDelay = args.delaySeconds !== undefined;
  const hasRunAt = args.runAt !== undefined;
  if (!hasDelay && !hasRunAt) throw new Error("Task wait requires delaySeconds or runAt");
  if (hasDelay) {
    const delay = Number(args.delaySeconds);
    if (!Number.isFinite(delay) || delay < TASK_WAIT_MIN_SECONDS || delay > TASK_WAIT_MAX_SECONDS) {
      throw new Error(`Task wait must be at least ${TASK_WAIT_MIN_SECONDS} seconds and no more than ${TASK_WAIT_MAX_SECONDS} seconds`);
    }
  }
  const parsed = hasRunAt ? Date.parse(String(args.runAt)) : NaN;
  if (hasRunAt && !Number.isFinite(parsed)) throw new Error("runAt must be a valid ISO-8601 timestamp");
  const runAt = Number.isFinite(parsed) ? parsed : now + Number(args.delaySeconds) * 1000;
  if (!Number.isFinite(runAt) || runAt <= now) throw new Error("Task wait time must be in the future (use runAt ISO or delaySeconds)");
  if (runAt < now + TASK_WAIT_MIN_SECONDS * 1000) throw new Error(`Task wait must be at least ${TASK_WAIT_MIN_SECONDS} seconds from now`);
  if (runAt > now + TASK_WAIT_MAX_SECONDS * 1000) throw new Error(`Task wait cannot be more than ${TASK_WAIT_MAX_SECONDS} seconds ahead`);
  return {
    runAt,
    checkpoint: bounded(args.checkpoint, "checkpoint", 4000),
    nextAction: bounded(args.nextAction, "nextAction", 1000),
    ...(args.reason !== undefined ? { reason: bounded(args.reason, "reason", 500) } : {}),
  };
}
