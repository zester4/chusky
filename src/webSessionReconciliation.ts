import { createHash } from "node:crypto";
import {
  backfillSdkPrivateRunHistory,
  createTask,
  getTask,
  listTaskOwnerIds,
  listTasks,
  mergeLinkedWebSession,
  requeueExpiredTask,
  retryTask,
  type TaskRecord,
  type WebSessionReconciliationTask,
} from "./store.js";
import { enqueueTaskWithClaim, type TaskWorkflowEnqueuer } from "./taskEnqueue.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import type { TaskRunResult } from "./taskRunner.js";

const RECONCILIATION_RETRY_MS = 30_000;
const RECOVERY_PUBLICATION_GRACE_MS = 60_000;
const MAX_RECOVERY_OWNERS = 10_000;

function assertUserId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function normalizedPayload(sourceUserId: number, telegramUserId?: number): WebSessionReconciliationTask {
  assertUserId(sourceUserId, "sourceUserId");
  if (telegramUserId !== undefined) assertUserId(telegramUserId, "telegramUserId");
  return { sourceUserId, ...(telegramUserId === undefined ? {} : { telegramUserId }) };
}

export function webSessionReconciliationTaskId(sourceUserId: number, telegramUserId?: number): string {
  const payload = normalizedPayload(sourceUserId, telegramUserId);
  const key = `${payload.sourceUserId}:${payload.telegramUserId ?? "unlinked"}`;
  return `task_web_reconcile_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
}

function isReconciliationTask(task: TaskRecord): task is TaskRecord & {
  taskKind: "web_session_reconciliation";
  webSessionReconciliation: WebSessionReconciliationTask;
} {
  const payload = task.webSessionReconciliation;
  return task.taskKind === "web_session_reconciliation"
    && Boolean(payload)
    && task.userId === payload!.sourceUserId
    && Number.isSafeInteger(payload!.sourceUserId)
    && payload!.sourceUserId > 0
    && (payload!.telegramUserId === undefined || (Number.isSafeInteger(payload!.telegramUserId) && payload!.telegramUserId > 0));
}

function waitingOutcome(): TaskRunResult {
  return {
    status: "queued",
    waiting: true,
    runAt: Date.now() + RECONCILIATION_RETRY_MS,
    message: "Web history reconciliation is waiting for the active session mutation to release its lease.",
    nextAction: "Retry the reconciliation after the active session mutation releases its lease.",
  };
}

/**
 * Create the one stable reconciliation task for an owner/session pair and
 * publish it through the same claim-before-QStash path as ordinary tasks.
 * The task payload contains IDs only; all history remains in owner-scoped
 * session storage and is read by the worker at execution time.
 */
export async function ensureWebSessionReconciliationTask(
  sourceUserId: number,
  telegramUserId?: number,
  enqueuer: TaskWorkflowEnqueuer = enqueueTaskWorkflow,
): Promise<{ task: TaskRecord; workflowRunId?: string }> {
  const payload = normalizedPayload(sourceUserId, telegramUserId);
  const taskId = webSessionReconciliationTaskId(sourceUserId, telegramUserId);
  let task = await getTask(sourceUserId, taskId);
  if (!task) {
    task = await createTask(sourceUserId, {
      id: taskId,
      title: "Reconcile linked web history",
      objective: "Import the owner’s private web session into the canonical Telegram session.",
      runAt: Date.now(),
      maxAttempts: 10,
      taskKind: "web_session_reconciliation",
      webSessionReconciliation: payload,
    });
  }
  if (!isReconciliationTask(task)) throw new Error("The durable reconciliation task has an invalid owner or payload.");
  if (task.status === "completed" || task.status === "running") return { task };
  if (["failed", "blocked", "cancelled"].includes(task.status)) {
    task = await retryTask(sourceUserId, task.id) ?? task;
    if (!isReconciliationTask(task)) throw new Error("The durable reconciliation task could not be requeued safely.");
  }
  if (task.status !== "queued") return { task };
  const workflowRunId = await enqueueTaskWithClaim(sourceUserId, task.id, task.runAt ?? Date.now(), enqueuer);
  return { task: await getTask(sourceUserId, task.id) ?? task, ...(workflowRunId ? { workflowRunId } : {}) };
}

/** Execute only the bounded, idempotent session-reconciliation operation. */
export async function executeWebSessionReconciliationTask(task: TaskRecord): Promise<TaskRunResult> {
  if (!isReconciliationTask(task)) {
    return { status: "failed", message: "The durable reconciliation task payload is invalid and was not executed." };
  }
  const { sourceUserId, telegramUserId } = task.webSessionReconciliation;
  const backfilled = await backfillSdkPrivateRunHistory(sourceUserId, { skipIfBusy: true });
  if (!backfilled) return waitingOutcome();
  if (telegramUserId === undefined) {
    return { status: "completed", message: "Private web history reconciliation completed.", result: "Private web history reconciliation completed." };
  }
  const merged = await mergeLinkedWebSession(sourceUserId, telegramUserId, { skipIfBusy: true });
  if (!merged) return waitingOutcome();
  return { status: "completed", message: "Linked web history reconciliation completed.", result: "Linked web history reconciliation completed." };
}

export interface WebSessionReconciliationRecoveryReport {
  owners: number;
  checked: number;
  republished: number;
  skipped: number;
  failures: Array<{ userId: number; taskId: string; error: string }>;
}

/**
 * Republish queued reconciliation tasks whose process died before the
 * workflow was published or before the task workflow could continue. The
 * persistent enqueue claim and QStash idempotency key make this safe to run
 * concurrently on every replica.
 */
export async function recoverWebSessionReconciliationTasks(
  enqueuer: TaskWorkflowEnqueuer = enqueueTaskWorkflow,
  options: { maxOwners?: number; now?: number } = {},
): Promise<WebSessionReconciliationRecoveryReport> {
  const ownerIds = await listTaskOwnerIds(Math.max(1, Math.min(MAX_RECOVERY_OWNERS, Math.floor(options.maxOwners ?? MAX_RECOVERY_OWNERS))));
  const now = options.now ?? Date.now();
  const report: WebSessionReconciliationRecoveryReport = { owners: ownerIds.length, checked: 0, republished: 0, skipped: 0, failures: [] };
  for (const userId of ownerIds) {
    const tasks = await listTasks(userId);
    for (const task of tasks) {
      if (task.taskKind !== "web_session_reconciliation") continue;
      report.checked += 1;
      if (!isReconciliationTask(task)) {
        report.skipped += 1;
        continue;
      }
      let candidate: TaskRecord = task;
      if (candidate.status === "running" && candidate.lease && candidate.lease.expiresAt <= now) {
        candidate = await requeueExpiredTask(userId, candidate.id, "Requeued an expired idempotent web history reconciliation lease.") ?? candidate;
      }
      if (!isReconciliationTask(candidate)) {
        report.skipped += 1;
        continue;
      }
      if (candidate.status !== "queued") {
        report.skipped += 1;
        continue;
      }
      const pendingClaimExpired = Boolean(candidate.enqueueClaim)
        && (candidate.enqueueClaim?.expiresAt ?? 0) <= now;
      const publishedWorkflowStale = Boolean(candidate.workflowRunId)
        && (candidate.workflowPublishedAt ?? 0) > 0
        && now - (candidate.workflowPublishedAt ?? 0) >= RECOVERY_PUBLICATION_GRACE_MS;
      if (candidate.workflowRunId && !pendingClaimExpired && !publishedWorkflowStale) {
        report.skipped += 1;
        continue;
      }
      try {
        const workflowRunId = await enqueueTaskWithClaim(userId, candidate.id, candidate.runAt ?? now, enqueuer);
        if (workflowRunId) report.republished += 1;
        else report.skipped += 1;
      } catch (error) {
        report.failures.push({ userId, taskId: candidate.id, error: error instanceof Error ? error.message.slice(0, 240) : "Reconciliation workflow publication failed." });
      }
    }
  }
  return report;
}
