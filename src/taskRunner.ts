import { claimTask, getTask, renewTaskLease, settleTaskRun, type TaskRecord } from "./store.js";
import { logger } from "./logger.js";

export interface TaskRunPayload { userId: number; taskId: string; }

export interface TaskRunResult {
  status: "completed" | "blocked" | "failed" | "queued" | "cancelled";
  message: string;
  checkpoint?: string;
  nextAction?: string;
  runAt?: number;
  result?: string;
}

export interface TaskRunnerDependencies {
  workerId: string;
  leaseMs?: number;
  execute(task: TaskRecord, signal?: AbortSignal): Promise<TaskRunResult>;
}

/**
 * Claims one task exactly once for its lease. The result is persisted through a
 * token-checked settlement, so a stale worker can never overwrite a recovered run.
 */
export async function executeDurableTask(payload: TaskRunPayload, deps: TaskRunnerDependencies): Promise<{ claimed: boolean; task?: TaskRecord }> {
  const leaseMs = Math.max(10_000, Math.min(10 * 60_000, deps.leaseMs ?? 120_000));
  const task = await claimTask(payload.userId, payload.taskId, deps.workerId, leaseMs);
  if (!task?.lease) {
    logger.info({ userId: payload.userId, taskId: payload.taskId, workerId: deps.workerId }, "Task worker skipped unclaimable task");
    return { claimed: false };
  }
  logger.info({ userId: payload.userId, taskId: task.id, attempt: task.attempt, workerId: deps.workerId }, "Task worker claimed task");
  const leaseAbort = new AbortController();
  let consecutiveRenewalFailures = 0;
  const renewal = setInterval(() => {
    void renewTaskLease(payload.userId, task.id, task.lease!.token, leaseMs).then((renewed) => {
      if (renewed) {
        consecutiveRenewalFailures = 0;
        return;
      }
      // A task-control tool can deliberately settle the task while the model
      // is still producing its closeout. That preserves the current worker's
      // token, but it is no longer a renewable `running` lease. Stop the
      // remaining turn without incorrectly reporting a stolen lease or a
      // worker failure.
      return getTask(payload.userId, task.id).then((current) => {
        if (current?.lease?.token === task.lease!.token && !["running", "cancel_requested"].includes(current.status)) {
          leaseAbort.abort(new Error("Task was settled by the current worker."));
          logger.info({ userId: payload.userId, taskId: task.id, workerId: deps.workerId, status: current.status }, "Task worker stopped after task lifecycle transition");
          return;
        }
        if (++consecutiveRenewalFailures >= 2) {
          leaseAbort.abort(new Error("Task lease was lost while the worker was executing."));
          logger.warn({ userId: payload.userId, taskId: task.id, workerId: deps.workerId }, "Task worker lost its lease");
        }
      }).catch((error) => {
        if (++consecutiveRenewalFailures >= 2) leaseAbort.abort(new Error("Task lease renewal failed repeatedly; stopping the worker before lease expiry."));
        logger.warn({ err: error, userId: payload.userId, taskId: task.id, consecutiveFailures: consecutiveRenewalFailures }, "Task lease state inspection failed");
      });
    }).catch((error) => {
      if (++consecutiveRenewalFailures >= 2) leaseAbort.abort(new Error("Task lease renewal failed repeatedly; stopping the worker before lease expiry."));
      logger.warn({ err: error, userId: payload.userId, taskId: task.id, consecutiveFailures: consecutiveRenewalFailures }, "Task lease renewal failed");
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  if (typeof renewal === "object" && "unref" in renewal) renewal.unref();
  try {
    const outcome = await deps.execute(task, leaseAbort.signal);
    const settled = await settleTaskRun(payload.userId, task.id, task.lease.token, outcome);
    logger.info({ userId: payload.userId, taskId: task.id, attempt: task.attempt, status: settled?.status }, "Task worker settled task");
    return { claimed: true, task: settled };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task worker failed";
    const current = await inspectDurableTask(payload);
    // The task may have been completed, blocked, failed, or requeued by an
    // in-turn native task control. Its state is already the authoritative
    // result; do not turn that normal handoff into an AbortError failure.
    if (current?.lease?.token === task.lease.token && !["running", "cancel_requested"].includes(current.status)) {
      logger.info({ userId: payload.userId, taskId: task.id, attempt: task.attempt, status: current.status }, "Task worker observed an in-turn lifecycle settlement");
      return { claimed: true, task: current };
    }
    if (current?.status === "cancel_requested" || current?.status === "cancelled") {
      const settled = await settleTaskRun(payload.userId, task.id, task.lease.token, {
        status: "cancelled",
        message: "Task cancellation completed while the worker was running.",
        checkpoint: task.checkpoint,
      });
      return { claimed: true, task: settled };
    }
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
  } finally {
    clearInterval(renewal);
  }
}

/** Read-only operator helper for reconciler/administrative callers. */
export async function inspectDurableTask(payload: TaskRunPayload): Promise<TaskRecord | undefined> {
  return getTask(payload.userId, payload.taskId);
}
