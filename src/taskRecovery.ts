import { randomUUID } from "node:crypto";
import {
  acquireTaskRecoveryLease,
  listOpenTasks,
  listTaskOwnerIds,
  releaseTaskRecoveryLease,
  renewTaskRecoveryLease,
  type TaskRecord,
} from "./store.js";
import { enqueueTaskWithClaim, type TaskWorkflowEnqueuer } from "./taskEnqueue.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";

const RECOVERY_LEASE_SECONDS = 120;
const RECOVERY_RENEWAL_INTERVAL_MS = 30_000;
const MAX_RECOVERY_OWNERS = 10_000;
const MAX_TASKS_PER_OWNER = 2_000;

export interface TaskRecoveryReport {
  owners: number;
  checked: number;
  republished: number;
  skipped: number;
  failures: Array<{ userId: number; taskId: string; error: string }>;
  /** Set when another replica currently owns the process-wide sweep lease. */
  skippedDueToLock?: boolean;
  /** Set when the sweeper stopped before advancing all owners after losing its lease. */
  leaseLost?: boolean;
}

/**
 * Mission tasks and web-session reconciliation tasks have their own recovery
 * state machines. Generic queued tasks are safe to republish only before a
 * worker has claimed them; an expired worker lease may represent an already
 * accepted external side effect and is therefore deliberately left for the
 * task/provider reconciliation path instead of being replayed here.
 */
function isGenericTask(task: TaskRecord): boolean {
  return task.taskKind === undefined && task.missionId === undefined;
}

function needsPublication(task: TaskRecord, now: number): boolean {
  if (task.status !== "queued") return false;

  // A recorded provider workflow is trusted. QStash failure callbacks clear
  // it when delivery is exhausted; republishing a still-recorded workflow
  // would risk running an external action twice.
  if (task.workflowRunId && !task.workflowRunId.startsWith("pending:")) return false;

  // A live claim belongs to another publisher. An absent claim on a pending
  // marker is treated as recoverable because it is a malformed/legacy
  // version of the crash window represented by the pending marker.
  if (task.enqueueClaim && task.enqueueClaim.expiresAt > now) return false;
  return true;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/**
 * Republish generic queued work whose process died before the QStash
 * publication was finalized. The task-level compare-and-set claim and the
 * provider's deterministic workflow ID make concurrent callers idempotent;
 * the distributed lease keeps the owner scan bounded to one replica.
 */
export async function recoverQueuedTaskWorkflows(
  enqueuer: TaskWorkflowEnqueuer = enqueueTaskWorkflow,
  options: { maxOwners?: number; maxTasksPerOwner?: number; now?: number } = {},
): Promise<TaskRecoveryReport> {
  const empty: TaskRecoveryReport = { owners: 0, checked: 0, republished: 0, skipped: 0, failures: [] };
  const token = randomUUID();
  if (!await acquireTaskRecoveryLease(token, RECOVERY_LEASE_SECONDS)) return { ...empty, skippedDueToLock: true };

  let leaseLost = false;
  let renewalInFlight: Promise<void> | undefined;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || leaseLost) return;
    renewalInFlight = (async () => {
      try {
        if (!await renewTaskRecoveryLease(token, RECOVERY_LEASE_SECONDS)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    })().finally(() => { renewalInFlight = undefined; });
  }, RECOVERY_RENEWAL_INTERVAL_MS);
  if (typeof renewalTimer === "object" && "unref" in renewalTimer) renewalTimer.unref();

  const report: TaskRecoveryReport = { ...empty };
  try {
    const maxOwners = Math.max(1, Math.min(MAX_RECOVERY_OWNERS, Math.floor(options.maxOwners ?? MAX_RECOVERY_OWNERS)));
    const maxTasksPerOwner = Math.max(1, Math.min(MAX_TASKS_PER_OWNER, Math.floor(options.maxTasksPerOwner ?? MAX_TASKS_PER_OWNER)));
    const now = options.now ?? Date.now();
    const ownerIds = await listTaskOwnerIds(maxOwners);
    report.owners = ownerIds.length;
    // Fast-exit: skip the expensive per-owner scan when no tasks exist at all.
    // Acquiring the lease already cost 1 Redis command; this saves all the rest.
    if (!ownerIds.length) {
      clearInterval(renewalTimer);
      await releaseTaskRecoveryLease(token).catch(() => false);
      return report;
    }

    for (const userId of ownerIds) {
      if (leaseLost) break;
      let tasks: TaskRecord[];
      try {
        tasks = await listOpenTasks(userId, maxTasksPerOwner);
      } catch (error) {
        report.failures.push({ userId, taskId: "*", error: boundedError(error) });
        continue;
      }

      for (const task of tasks) {
        if (leaseLost) break;
        if (!isGenericTask(task)) continue;
        report.checked += 1;
        if (!needsPublication(task, now)) {
          report.skipped += 1;
          continue;
        }
        try {
          const workflowRunId = await enqueueTaskWithClaim(userId, task.id, task.runAt ?? now, enqueuer);
          if (workflowRunId) report.republished += 1;
          else report.skipped += 1;
        } catch (error) {
          // Leave the task queued. The claim helper clears its failed pending
          // claim, so the next sweep or an explicit retry can safely try again.
          report.failures.push({ userId, taskId: task.id, error: boundedError(error) });
        }
      }
    }
    if (leaseLost) report.leaseLost = true;
    return report;
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
    await releaseTaskRecoveryLease(token);
  }
}

/** Exposed for operational documentation without duplicating limits. */
export const taskRecoveryPolicy = {
  maxOwners: MAX_RECOVERY_OWNERS,
  maxTasksPerOwner: MAX_TASKS_PER_OWNER,
} as const;
