import { createHash } from "node:crypto";
import { enqueueTaskWithClaim } from "../taskEnqueue.js";
import { createTask, scheduleTask, type PhoneCallRecord } from "../store.js";
import type { PhoneCallOutcome } from "./outcome.js";

export interface PhoneCallFollowUpResult {
  taskIds: string[];
  scheduled: number;
  existing: number;
}
export interface PhoneCallFollowUpDependencies {
  enqueueTask?: (userId: number, taskId: string, runAt: number) => Promise<string | undefined>;
}

function clean(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function taskIdFor(call: PhoneCallRecord, index: number, item: PhoneCallOutcome["actionItems"][number]): string {
  const fingerprint = [call.id, index, item.task, item.owner, item.dueDate ?? ""].join("\n");
  return `task_call_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 48)}`;
}

/**
 * Only exact, timezone-bearing timestamps are used to delay work. A natural
 * language date has no trustworthy timezone, so it is retained in the task
 * objective and the task starts immediately for safe owner review.
 */
function runAtFor(dueDate: string | undefined, now = Date.now()): number {
  if (!dueDate) return now + 1_000;
  const value = dueDate.trim();
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value)
    : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : now + 1_000;
}

/**
 * Turn a structured phone outcome into idempotent durable work. The task
 * worker retains the normal approval, provider-receipt, and retry rules; this
 * helper only admits the bounded action items extracted from the call.
 */
export async function schedulePhoneCallFollowUps(
  call: PhoneCallRecord,
  outcome: PhoneCallOutcome,
  dependencies: PhoneCallFollowUpDependencies = {},
): Promise<PhoneCallFollowUpResult> {
  const enqueue = dependencies.enqueueTask ?? enqueueTaskWithClaim;
  const taskIds: string[] = [];
  let scheduled = 0;
  let existing = 0;

  for (const [index, item] of outcome.actionItems.slice(0, 10).entries()) {
    const taskId = taskIdFor(call, index, item);
    const runAt = runAtFor(item.dueDate);
    const task = await createTask(call.userId, {
      id: taskId,
      title: `Call follow-up: ${clean(item.task, 100)}`,
      objective: [
        `Follow up on the completed phone call ${call.id}.`,
        `Action owner: ${clean(item.owner, 120)}.`,
        `Verified action item: ${clean(item.task, 500)}`,
        item.dueDate ? `Recorded due date: ${clean(item.dueDate, 80)}.` : "No due date was explicitly recorded.",
        "Use only the verified call outcome and the owner's available tools. Preserve normal approval requirements for external messages, commitments, payments, permissions, and other high-impact actions. Do not invent contact details or claim completion without a provider receipt.",
      ].join(" ").slice(0, 3_000),
      runAt,
      maxAttempts: 5,
    });
    taskIds.push(task.id);

    if (["completed", "cancelled"].includes(task.status)) {
      existing += 1;
      continue;
    }
    if (task.workflowRunId) {
      existing += 1;
      continue;
    }

    const scheduledTask = await scheduleTask(call.userId, task.id, runAt);
    if (!scheduledTask) {
      existing += 1;
      continue;
    }
    const workflowRunId = await enqueue(call.userId, task.id, runAt);
    if (!workflowRunId) {
      throw new Error("A call follow-up task is already being queued; retry the post-call reconciliation.");
    }
    scheduled += 1;
  }

  return { taskIds, scheduled, existing };
}
