import { claimTask, getTask, settleTaskRun, type TaskRecord } from "./store.js";
import { logger } from "./logger.js";

export interface TaskRunPayload { userId: number; taskId: string; }

export interface TaskRunResult {
  status: "completed" | "blocked" | "failed" | "queued";
  message: string;
  checkpoint?: string;
  nextAction?: string;
  result?: string;
}

export interface TaskRunnerDependencies {
  workerId: string;
  execute(task: TaskRecord): Promise<TaskRunResult>;
}

/**
 * Claims one task exactly once for its lease. The result is persisted through a
 * token-checked settlement, so a stale worker can never overwrite a recovered run.
 */
export async function executeDurableTask(payload: TaskRunPayload, deps: TaskRunnerDependencies): Promise<{ claimed: boolean; task?: TaskRecord }> {
  const task = await claimTask(payload.userId, payload.taskId, deps.workerId);
  if (!task?.lease) {
    logger.info({ userId: payload.userId, taskId: payload.taskId, workerId: deps.workerId }, "Task worker skipped unclaimable task");
    return { claimed: false };
  }
  logger.info({ userId: payload.userId, taskId: task.id, attempt: task.attempt, workerId: deps.workerId }, "Task worker claimed task");
  try {
    const outcome = await deps.execute(task);
    const settled = await settleTaskRun(payload.userId, task.id, task.lease.token, outcome);
    logger.info({ userId: payload.userId, taskId: task.id, attempt: task.attempt, status: settled?.status }, "Task worker settled task");
    return { claimed: true, task: settled };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task worker failed";
    const settled = await settleTaskRun(payload.userId, task.id, task.lease.token, {
      status: "failed",
      message: message.slice(0, 1000),
      checkpoint: task.checkpoint,
      nextAction: "Retry the task after the transient failure is resolved.",
    });
    logger.warn({ userId: payload.userId, taskId: task.id, attempt: task.attempt, status: settled?.status, errorClass: error instanceof Error ? error.name : "unknown" }, "Task worker failed");
    return {
      claimed: true,
      task: settled,
    };
  }
}

/** Read-only operator helper for reconciler/administrative callers. */
export async function inspectDurableTask(payload: TaskRunPayload): Promise<TaskRecord | undefined> {
  return getTask(payload.userId, payload.taskId);
}
