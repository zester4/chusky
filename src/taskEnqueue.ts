import { randomUUID } from "node:crypto";
import { claimTaskEnqueue, setTaskWorkflowRunId } from "./store.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";

export type TaskWorkflowEnqueuer = (userId: number, taskId: string, runAt: number) => Promise<string>;
export type TaskWorkflowFinalizer = (userId: number, taskId: string, workflowRunId: string, expectedWorkflowRunId: string) => Promise<unknown>;

/**
 * Publish a durable task exactly once per enqueue attempt.
 *
 * The claim is persisted before contacting QStash. If the process dies after
 * QStash accepts the request but before the workflow id is written, the
 * expired pending claim can be recovered and the stable provider idempotency
 * key prevents a second workflow from being created.
 */
export async function enqueueTaskWithClaim(
  userId: number,
  taskId: string,
  runAt: number,
  enqueuer: TaskWorkflowEnqueuer = enqueueTaskWorkflow,
  finalizer: TaskWorkflowFinalizer = setTaskWorkflowRunId,
): Promise<string | undefined> {
  const token = randomUUID();
  const claimed = await claimTaskEnqueue(userId, taskId, token);
  if (!claimed) return undefined;
  try {
    const workflowRunId = await enqueuer(userId, taskId, runAt);
    const recorded = await finalizer(userId, taskId, workflowRunId, `pending:${token}`);
    if (!recorded) {
      throw new Error("Task workflow was published but its provider run ID could not be recorded; enqueue recovery will reconcile it.");
    }
    return workflowRunId;
  } catch (error) {
    await finalizer(userId, taskId, "", `pending:${token}`).catch(() => undefined);
    throw error;
  }
}
