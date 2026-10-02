import type { MissionRecord, MissionStepRecord, TaskRecord } from "./store.js";

export interface MissionSliceState {
  task?: Pick<TaskRecord, "status" | "checkpoint" | "nextAction" | "result" | "error" | "runAt">;
  mission?: Pick<MissionRecord, "status" | "checkpoint" | "nextAction" | "waiting" | "consumedSteps" | "toolCalls" | "cost" | "currentStepId" | "activeStepIds" | "steps" | "evidence" | "events">;
}

/** Lifecycle tools remain available to the durable mission supervisor even
 * when a step is fenced to a small set of provider/native tools. */
export const MISSION_WORKER_CONTROL_TOOLS = [
  "CHUCK_TASK_WAIT",
  "CHUCK_MISSION_GET",
  "CHUCK_MISSION_PROOF",
  "CHUCK_MISSION_CHECKPOINT",
  "CHUCK_MISSION_WAIT_EVENT",
  "CHUCK_MISSION_STEP_COMPLETE",
  "CHUCK_MISSION_EVIDENCE",
  "CHUCK_MISSION_VERIFY",
  "CHUCK_MISSION_COMPLETE",
  "CHUCK_MISSION_BLOCK",
  "CHUCK_MISSION_REPLAN",
  "CHUCK_MISSION_REPAIR",
  "CHUCK_MISSION_RESUME",
] as const;

export function missionWorkerToolAllowlist(stepTools?: string[], inheritedTools?: string[]): string[] | undefined {
  if (stepTools === undefined) return inheritedTools;
  const inherited = inheritedTools ? new Set(inheritedTools) : undefined;
  const selected = stepTools.filter((tool) => !inherited || inherited.has(tool));
  return [...new Set([...MISSION_WORKER_CONTROL_TOOLS, ...selected])];
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
      events: [],
      // Lease acquisition/release is worker coordination, not mission work.
      // Exclude it so a model turn with no action cannot masquerade as
      // progress merely because the execution lease changed.
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
 * Turn a model-provided wait description into an executable post-wake action.
 * The model may describe the whole mission when it parks; the durable runtime
 * must persist the active step as the authoritative continuation instead.
 */
export function missionPostWakeNextAction(
  step: Pick<MissionStepRecord, "title" | "objective"> | undefined,
  requestedNextAction: string,
): string {
  const requested = requestedNextAction.trim().slice(0, 900);
  if (!step) return `After the durable wait wakes, execute the saved action now. Do not wait again. Saved action: ${requested}`.slice(0, 2000);
  return `After the durable wait wakes, execute only mission step “${step.title}” now: ${step.objective} Do not call CHUCK_TASK_WAIT again. Persist the post-wake result and complete this step when its objective is verified. Saved continuation: ${requested}`.slice(0, 2000);
}

/** A timer wake with no tool call is safe to retry once inside the same slice. */
export function missionWakeNeedsRecovery(
  resumed: boolean,
  result: { toolsUsed: string[]; taskWait?: unknown; missionWait?: unknown },
): boolean {
  return resumed && result.toolsUsed.length === 0 && !result.taskWait && !result.missionWait;
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
  const matchesStep = (event: { stepId?: string }) => !event.stepId || !stepId || event.stepId === stepId;
  const terminalOrProgressEvents = new Set([
    "checkpointed", "waiting", "paused", "blocked", "completed", "failed", "cancelled",
    "budget_exhausted", "step_started", "step_completed", "step_failed", "approval_waiting",
    "approval_resumed", "replanned", "repaired", "provider_event",
  ]);
  // Lease churn and task coordination events do not consume the wake marker.
  // Any later mission progress does: otherwise a stale timer-resumed event can
  // incorrectly make a future slice look like the first post-wake slice.
  for (const event of [...mission.events].reverse()) {
    if (!matchesStep(event)) continue;
    if (event.type === "resumed" && /^Timer wait reached\b/i.test(event.message)) return true;
    if (terminalOrProgressEvents.has(event.type)) return false;
  }
  return false;
}
