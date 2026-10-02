import { getMission, getTask, recordMissionSlice, finalizeMissionIfReady, type TaskRecord, type MissionRecord, type MissionStepRecord } from "./store.js";
import { captureMissionSliceState, missionSliceHasPersistedProgress, missionNoProgressNextAction, type MissionSliceState } from "./missionWorker.js";
import { reconcileMissionExecution, type MissionTaskEnqueuer } from "./missionScheduler.js";
import type { TaskRunResult } from "./taskRunner.js";

export interface MissionSliceResult { text: string; toolsUsed: string[]; toolsSucceeded?: string[]; cost?: number }

export interface MissionSliceInput {
  task: TaskRecord;
  mission: MissionRecord;
  currentMissionStep?: Pick<MissionStepRecord, "title" | "objective">;
  result: MissionSliceResult;
  before: MissionSliceState;
  enqueue: MissionTaskEnqueuer;
}

/** Production post-turn accounting and dependency handoff, independent of HTTP. */
export async function settleMissionSlice({ task, mission, currentMissionStep, result, before, enqueue }: MissionSliceInput): Promise<TaskRunResult> {
  const currentMissionBeforeAccounting = await getMission(task.userId, mission.id);
  const currentTaskAfterTurn = await getTask(task.userId, task.id);
  const missionSliceAfter = captureMissionSliceState(currentTaskAfterTurn, currentMissionBeforeAccounting);
  if (!missionSliceHasPersistedProgress(before, missionSliceAfter)) {
    const externalAttempt = result.toolsUsed.some((tool) => !tool.startsWith("CHUCK_"));
    const noProgressMessage = externalAttempt
      ? `Mission worker attempted an external tool but persisted no progress for ${currentMissionStep?.title ?? "the active step"}. The mission is paused for provider-state inspection so a retry cannot duplicate an uncertain action.`
      : `Mission worker ended the slice without persisting progress for ${currentMissionStep?.title ?? "the active step"}. No provider action, checkpoint, wait, evidence, or step completion was recorded.`;
    const noProgressNextAction = externalAttempt ? "Inspect the provider receipt/state, then resume this same mission only after the outcome is known." : missionNoProgressNextAction(currentMissionStep);
    const accounted = await recordMissionSlice(task.userId, mission.id, {
      checkpoint: currentMissionBeforeAccounting?.checkpoint ?? mission.checkpoint,
      nextAction: noProgressNextAction,
      toolCalls: result.toolsUsed.length,
      cost: result.cost,
      ...(externalAttempt ? { blockedReason: noProgressMessage } : {}),
    });
    if (externalAttempt || accounted?.status === "blocked") {
      return { status: "blocked" as const, message: accounted?.error ?? noProgressMessage, checkpoint: accounted?.checkpoint ?? currentMissionBeforeAccounting?.checkpoint ?? mission.checkpoint, nextAction: accounted?.nextAction ?? noProgressNextAction };
    }
    return { status: "failed" as const, message: noProgressMessage, checkpoint: accounted?.checkpoint ?? currentMissionBeforeAccounting?.checkpoint ?? mission.checkpoint, nextAction: noProgressNextAction };
  }
  const beforeAccounting = await getMission(task.userId, mission.id);
  const accounted = await recordMissionSlice(task.userId, mission.id, { checkpoint: beforeAccounting?.checkpoint ?? result.text, nextAction: beforeAccounting?.nextAction ?? "Continue from the verified checkpoint.", toolCalls: result.toolsUsed.length, cost: result.cost });
  const currentMission = accounted ?? await getMission(task.userId, mission.id);
  if (currentMission?.status === "completed") return { status: "completed" as const, message: "Autonomous mission completed", result: currentMission.result, checkpoint: currentMission.checkpoint };
  if (currentMission?.status === "cancelled") return { status: "cancelled" as const, message: currentMission.error ?? "Autonomous mission cancelled" };
  if (currentMission?.status === "paused" || currentMission?.status === "blocked" || currentMission?.status === "failed") return { status: "blocked" as const, message: currentMission.error ?? "Autonomous mission is waiting for intervention", checkpoint: currentMission.checkpoint, nextAction: currentMission.nextAction };
  if (!accounted || accounted.status === "blocked") return { status: "blocked" as const, message: accounted?.error ?? "Autonomous mission could not record its progress", checkpoint: accounted?.checkpoint, nextAction: accounted?.nextAction };
  // Close out after the final model/tool turn. Without this
  // server-side handoff, a mission with no ready steps would be
  // requeued forever waiting for a model to remember a separate
  // verify/complete call.
  const finalized = await finalizeMissionIfReady(task.userId, mission.id, { blockOnUnresolved: true });
  if (finalized?.status === "completed") return { status: "completed" as const, message: "Autonomous mission completed", result: finalized.result, checkpoint: finalized.checkpoint };
  if (finalized?.status === "blocked" || finalized?.status === "failed") return { status: "blocked" as const, message: finalized.error ?? "Autonomous mission needs evidence or repair", checkpoint: finalized.checkpoint, nextAction: finalized.nextAction };
  const refreshed = await getMission(task.userId, mission.id);
  if (refreshed) {
    await reconcileMissionExecution(task.userId, mission.id, enqueue, task.id);
    if (task.missionStepId && refreshed.activeStepIds?.length && !refreshed.activeStepIds.includes(task.missionStepId)) {
      return { status: "completed" as const, message: "Mission branch completed; the next dependency-ready branch was scheduled.", result: result.text, checkpoint: refreshed.checkpoint };
    }
  }
  return { status: "queued" as const, message: "Autonomous mission slice completed", checkpoint: accounted.checkpoint, nextAction: accounted.nextAction ?? "Continue from the verified checkpoint.", runAt: Date.now() + 5000, progress: true };
}
