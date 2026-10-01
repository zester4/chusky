import { enqueueTaskWithClaim, type TaskWorkflowEnqueuer } from "./taskEnqueue.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import {
  createApproval,
  getMission,
  listApprovals,
  listTasks,
  missionBudgetPreflight,
  resumeMissionFromApproval,
  retryTask,
  setApprovalStatus,
  updateTask,
  waitMission,
  type MissionRecord,
  type TaskRecord,
} from "./store.js";

export const DEFAULT_MISSION_DURATION_EXTENSION_SECONDS = 5 * 60;

/**
 * A mission can discover that its execution allowance is exhausted while no
 * interactive run is alive to emit a normal ApprovalRequiredError. This error
 * lets the native resume path enter the same approval lifecycle without
 * turning the request into assistant prose.
 */
export class MissionDurationApprovalRequiredError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly args: Record<string, unknown>,
  ) {
    super(`Approval required before extending mission duration. Approval ID: ${approvalId}`);
    this.name = "MissionDurationApprovalRequiredError";
  }
}

export interface MissionApprovalTarget {
  mission: MissionRecord;
  task: TaskRecord;
}

export type MissionApprovalResumeResult =
  | { status: "not_mission" }
  | { status: "resumed" | "already_queued"; mission: MissionRecord; taskId: string }
  | { status: "not_resumable" | "task_running" | "enqueue_failed"; mission?: MissionRecord; taskId?: string; error?: unknown };

function proposedMissionDurationSeconds(mission: MissionRecord, extensionSeconds: number): number {
  const now = Date.now();
  const elapsedSinceStart = mission.startedAt ? Math.max(0, Math.ceil((now - mission.startedAt) / 1000)) : 0;
  // Active-time missions only need another bounded execution allowance. A
  // legacy wall-clock mission must be extended from its original start, or a
  // long pause would immediately consume the newly approved duration.
  const proposed = mission.budget.durationMode === "wall_clock"
    ? Math.max(mission.budget.maxDurationSeconds + extensionSeconds, elapsedSinceStart + extensionSeconds)
    : mission.budget.maxDurationSeconds + extensionSeconds;
  return Math.min(2_592_000, Math.max(mission.budget.maxDurationSeconds + 1, proposed));
}

/**
 * Create the one owner approval needed to extend an exhausted mission timer.
 * The exact resume arguments are persisted in the approval, and repeated
 * worker wakes return the same pending approval instead of creating a queue.
 */
export async function requestMissionDurationApproval(
  userId: number,
  missionId: string,
  context: { taskId?: string; model?: string } = {},
): Promise<{ approval: Awaited<ReturnType<typeof createApproval>>; mission: MissionRecord } | undefined> {
  const mission = await getMission(userId, missionId);
  if (!mission) return undefined;
  const preflight = missionBudgetPreflight(mission, { steps: 1, toolCalls: 1, cost: 0.0001, durationSeconds: 1 });
  if (preflight.allowed || preflight.reason !== "Mission duration budget would be exceeded.") return undefined;
  if (mission.budget.maxLifetimeSeconds !== undefined && mission.startedAt && Date.now() - mission.startedAt >= mission.budget.maxLifetimeSeconds * 1000) return undefined;

  const existingApproval = (await listApprovals(userId, 100)).find((item) =>
    item.status === "pending" && item.expiresAt > Date.now() && item.toolSlug === "CHUCK_MISSION_RESUME"
      && (item.missionId === mission.id || item.args.id === mission.id),
  );
  if (existingApproval) {
    const waiting = await waitMission(userId, mission.id, {
      kind: "approval",
      key: existingApproval.id,
      stepId: mission.currentStepId,
      expiresAt: existingApproval.expiresAt,
    }, mission.checkpoint, `Mission time is exhausted. Approve the bounded ${DEFAULT_MISSION_DURATION_EXTENSION_SECONDS / 60}-minute extension to continue this mission.`);
    return waiting ? { approval: existingApproval, mission: waiting } : undefined;
  }

  const maxDurationSeconds = proposedMissionDurationSeconds(mission, DEFAULT_MISSION_DURATION_EXTENSION_SECONDS);
  const approval = await createApproval({
    userId,
    missionId: mission.id,
    toolSlug: "CHUCK_MISSION_RESUME",
    args: { id: mission.id, maxDurationSeconds },
    request: `Mission “${mission.title}” has exhausted its execution time. Approve an extension to ${maxDurationSeconds} total seconds from the original start so Chusky can resume the saved checkpoint and continue verification.`,
    history: [],
    model: context.model || "chusky/mission-supervisor",
  });
  const waiting = await waitMission(userId, mission.id, {
    kind: "approval",
    key: approval.id,
    stepId: mission.currentStepId,
    expiresAt: approval.expiresAt,
  }, mission.checkpoint, `Mission time is exhausted. Approve the exact ${DEFAULT_MISSION_DURATION_EXTENSION_SECONDS / 60}-minute extension to continue from the saved checkpoint.`);
  if (!waiting) {
    await setApprovalStatus(userId, approval.id, "expired").catch(() => undefined);
    return undefined;
  }
  return { approval, mission: waiting };
}

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
  options: { maxDurationSeconds?: number } = {},
): Promise<MissionApprovalResumeResult> {
  const target = await findMissionApprovalTarget(userId, approvalId);
  if (!target) return { status: "not_mission" };

  const { mission, task } = target;
  if (task.status === "running" || task.status === "cancel_requested") return { status: "task_running", mission, taskId: task.id };
  if (!["queued", "blocked", "failed", "cancelled"].includes(task.status)) return { status: "not_resumable", mission, taskId: task.id };

  const resumedMission = await resumeMissionFromApproval(userId, mission.id, approvalId, options.maxDurationSeconds);
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
