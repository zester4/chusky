import type { MissionRecord, MissionStepRecord, TaskRecord } from "./store.js";

export interface MissionSliceState {
  task?: Pick<TaskRecord, "status" | "checkpoint" | "nextAction" | "result" | "error" | "runAt">;
  mission?: Pick<MissionRecord, "status" | "checkpoint" | "nextAction" | "waiting" | "consumedSteps" | "toolCalls" | "cost" | "currentStepId" | "activeStepIds" | "steps" | "evidence" | "events">;
}

/** Capture only durable fields that a worker slice is expected to change. */
export function captureMissionSliceState(task?: TaskRecord, mission?: MissionRecord): MissionSliceState {
  return {
    task: task ? {
      status: task.status,
      checkpoint: task.checkpoint,
      nextAction: task.nextAction,
      result: task.result,
      error: task.error,
      runAt: task.runAt,
    } : undefined,
    mission: mission ? {
      status: mission.status,
      checkpoint: mission.checkpoint,
      nextAction: mission.nextAction,
      waiting: mission.waiting,
      consumedSteps: mission.consumedSteps,
      toolCalls: mission.toolCalls,
      cost: mission.cost,
      currentStepId: mission.currentStepId,
      activeStepIds: mission.activeStepIds,
      steps: mission.steps,
      evidence: mission.evidence,
      // Lease acquisition/release is worker coordination, not mission work.
      // Exclude it so a model turn with no action cannot masquerade as
      // progress merely because the execution lease changed.
      events: mission.events.filter((event) => event.type !== "lease_acquired" && event.type !== "lease_released"),
    } : undefined,
  };
}

function changed<T>(before: T | undefined, after: T | undefined): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * A mission slice has made progress only when that progress is durable. Model
 * prose or an unpersisted provider call is not enough: retrying it could repeat
 * an external action without a checkpoint or evidence frontier.
 */
export function missionSliceHasPersistedProgress(before: MissionSliceState, after: MissionSliceState): boolean {
  if (changed(before.task, after.task)) return true;
  if (changed(before.mission, after.mission)) return true;
  return false;
}

export function missionStepInstruction(step?: Pick<MissionStepRecord, "title" | "objective">): string {
  if (!step) return "Determine the next concrete mission action from the persisted checkpoint, then execute it now.";
  return `Execute only this mission step now: ${step.title}\nStep objective: ${step.objective}\nDo not summarize the remaining mission or defer this step to another worker. Persist the result, evidence, checkpoint, wait, block, or step completion before ending this slice.`;
}

export function missionNoProgressNextAction(step?: Pick<MissionStepRecord, "title" | "objective">): string {
  if (!step) return "Retry the worker with one concrete action and persist its result before ending the slice.";
  return `Retry the worker for step “${step.title}” and execute this objective directly: ${step.objective}`;
}

/**
 * A supervisor may resume a timer-waiting mission before its durable worker
 * claims the task. Keep the wake marker visible to that worker so it receives
 * post-wake instructions instead of treating the resumed mission as a fresh
 * first slice.
 */
export function missionHasTimerWakeContinuation(
  mission?: Pick<MissionRecord, "status" | "events" | "currentStepId" | "activeStepIds">,
  missionStepId?: string,
): boolean {
  if (!mission || mission.status !== "running") return false;
  const stepId = missionStepId ?? mission.currentStepId ?? mission.activeStepIds?.[0];
  return [...mission.events].reverse().some((event) => event.type === "resumed"
    && /^Timer wait reached\b/i.test(event.message)
    && (!event.stepId || !stepId || event.stepId === stepId));
}
