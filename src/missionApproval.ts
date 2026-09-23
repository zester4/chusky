import { enqueueTaskWithClaim, type TaskWorkflowEnqueuer } from "./taskEnqueue.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import {
  getMission,
  listTasks,
  resumeMissionFromApproval,
  retryTask,
  updateTask,
  type MissionRecord,
  type TaskRecord,
} from "./store.js";

export interface MissionApprovalTarget {
  mission: MissionRecord;
  task: TaskRecord;
}

export type MissionApprovalResumeResult =
  | { status: "not_mission" }
  | { status: "resumed" | "already_queued"; mission: MissionRecord; taskId: string }
  | { status: "not_resumable" | "task_running" | "enqueue_failed"; mission?: MissionRecord; taskId?: string; error?: unknown };

/** Find the precise durable slice named by a mission's approval wait. */
export async function findMissionApprovalTarget(userId: number, approvalId: string): Promise<MissionApprovalTarget | undefined> {
  for (const task of await listTasks(userId)) {
    if (!task.missionId) continue;
    const mission = await getMission(userId, task.missionId);
    const waiting = mission?.waiting;
    if (mission?.status !== "waiting" || waiting?.kind !== "approval" || waiting.key !== approvalId) continue;
    if (waiting.stepId && task.missionStepId && waiting.stepId !== task.missionStepId) continue;
    return { mission, task };
  }
  return undefined;
}

/**
 * Consume an approved mission wait and publish its original task immediately.
 * Approval-paused tasks are usually queued with a future wake-up, not blocked;
 * replacing that wake-up is safe because task leases prevent duplicate slices.
 */
export async function resumeMissionTaskAfterApproval(
  userId: number,
  approvalId: string,
  enqueuer: TaskWorkflowEnqueuer = enqueueTaskWorkflow,
): Promise<MissionApprovalResumeResult> {
  const target = await findMissionApprovalTarget(userId, approvalId);
  if (!target) return { status: "not_mission" };

  const { mission, task } = target;
  if (task.status === "running" || task.status === "cancel_requested") return { status: "task_running", mission, taskId: task.id };
  if (!["queued", "blocked", "failed", "cancelled"].includes(task.status)) return { status: "not_resumable", mission, taskId: task.id };

  const resumedMission = await resumeMissionFromApproval(userId, mission.id, approvalId);
  if (!resumedMission) return { status: "not_resumable", mission, taskId: task.id };

  let readyTask: TaskRecord | undefined;
  if (task.status === "queued") {
    readyTask = await updateTask(userId, task.id, {
      status: "queued",
      runAt: Date.now(),
      workflowRunId: undefined,
      enqueueClaim: undefined,
      error: undefined,
      nextAction: "Resume this mission slice now that its approval was granted.",
      approvedApprovalId: approvalId,
    });
  } else {
    readyTask = await retryTask(userId, task.id);
    if (readyTask) readyTask = await updateTask(userId, task.id, { approvedApprovalId: approvalId });
  }
  if (!readyTask) return { status: "enqueue_failed", mission: resumedMission, taskId: task.id };

  try {
    const workflowRunId = await enqueueTaskWithClaim(userId, task.id, readyTask.runAt ?? Date.now(), enqueuer);
    return { status: workflowRunId ? "resumed" : "already_queued", mission: resumedMission, taskId: task.id };
  } catch (error) {
    return { status: "enqueue_failed", mission: resumedMission, taskId: task.id, error };
  }
}
