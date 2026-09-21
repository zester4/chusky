import { createHash } from "node:crypto";
import {
  createTask,
  getMission,
  listTasks,
  retryTask,
  updateMission,
  type MissionRecord,
} from "./store.js";
import { enqueueTaskWithClaim } from "./taskEnqueue.js";

/** Enqueue one durable task through the caller's workflow provider. */
export type MissionTaskEnqueuer = (userId: number, taskId: string, runAt: number) => Promise<string>;

function taskIdFor(missionId: string, stepId: string): string {
  return `task_${createHash("sha256").update(`${missionId}:${stepId}`).digest("hex").slice(0, 48)}`;
}

/**
 * Materialize every dependency-ready mission step as an idempotent durable
 * task. A mission can therefore fan out independent work and later converge
 * through completeMissionStep's dependency scheduler.
 */
export async function scheduleMissionSteps(userId: number, mission: MissionRecord, enqueue: MissionTaskEnqueuer): Promise<MissionRecord | undefined> {
  const current = await getMission(userId, mission.id);
  if (!current || !["running", "waiting"].includes(current.status)) return current;
  const active = current.activeStepIds?.length ? current.activeStepIds : current.currentStepId ? [current.currentStepId] : [];
  if (!active.length) return current;
  const tasks = await listTasks(userId);
  const assigned = new Map<string, string>();
  const now = Date.now();
  for (const stepId of active) {
    const step = current.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.status !== "running") continue;
    let task = tasks.find((candidate) => candidate.missionId === current.id && candidate.missionStepId === stepId);
    let shouldEnqueue = false;
    if (!task) {
      task = await createTask(userId, {
        id: taskIdFor(current.id, stepId),
        title: `Mission: ${current.title} / ${step.title}`,
        objective: step.objective,
        missionId: current.id,
        missionStepId: stepId,
        runAt: now,
        maxAttempts: Math.max(1, Math.min(10, (step.retryLimit ?? 2) + 1)),
      });
      shouldEnqueue = task.status === "queued";
    } else if (["failed", "cancelled", "blocked"].includes(task.status)) {
      const retried = await retryTask(userId, task.id);
      if (retried) {
        task = retried;
        shouldEnqueue = true;
      }
    }
    if (!task) continue;
    // A publisher can crash after claiming the enqueue slot but before the
    // provider workflow id is persisted. The task deliberately keeps a
    // `pending:<token>` marker during that window, so the scheduler must
    // treat an expired marker as recoverable rather than waiting forever.
    const pendingClaimExpired = task.workflowRunId?.startsWith("pending:") === true
      && (!task.enqueueClaim || task.enqueueClaim.expiresAt <= Date.now());
    if (shouldEnqueue || (task.status === "queued" && (!task.workflowRunId || pendingClaimExpired))) {
      await enqueueTaskWithClaim(userId, task.id, task.runAt ?? now, enqueue);
    }
    assigned.set(stepId, task.id);
  }
  if (!assigned.size) return current;
  const linked = await updateMission(userId, current.id, (latest) => {
    if (["completed", "cancelled"].includes(latest.status)) return undefined;
    return {
      rootTaskId: latest.rootTaskId ?? assigned.values().next().value,
      steps: latest.steps.map((step) => assigned.has(step.id) && step.status === "running" ? { ...step, taskId: assigned.get(step.id), updatedAt: now } : step),
      events: [...latest.events, {
        id: `misevt_${createHash("sha256").update(`${latest.id}:${now}:${assigned.size}`).digest("hex").slice(0, 24)}`,
        type: "step_started",
        message: `Scheduled ${assigned.size} dependency-ready mission step${assigned.size === 1 ? "" : "s"}.`,
        at: now,
        metadata: { stepCount: assigned.size },
      }],
    };
  });
  return linked ?? current;
}
