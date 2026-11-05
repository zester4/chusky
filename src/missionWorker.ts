import type { Message, MissionRecord, MissionStepRecord, TaskRecord } from "./store.js";

const MISSION_HISTORY_MAX_MESSAGES = 8;
const MISSION_HISTORY_MAX_CHARS = 8000;

/** Keep resumed mission turns independent from an unbounded owner chat history. */
export function boundedMissionHistory(history: readonly Message[]): Message[] {
  const candidates = history.filter((message) =>
    (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim().length > 0,
  );
  const selected: Message[] = [];
  let chars = 0;
  for (let index = candidates.length - 1; index >= 0 && selected.length < MISSION_HISTORY_MAX_MESSAGES; index--) {
    const message = candidates[index]!;
    const remaining = MISSION_HISTORY_MAX_CHARS - chars;
    if (remaining <= 0) break;
    const content = String(message.content).slice(-Math.min(2000, remaining));
    if (!content) continue;
    selected.unshift({ role: message.role, content });
    chars += content.length;
  }
  return selected;
}

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
  "CHUCK_MISSION_DOCTOR",
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
  "CHUCK_MISSION_CONTROL",
] as const;

/** Derive preload hints when a planner did not provide an exact tool fence. */
export function deriveMissionToolHints(objective: string): string[] {
  const text = objective.toLowerCase();
  const selected = new Set<string>();
  if (/email|gmail|outlook|slack|notion|calendar|github|crm|stripe|invoice|ticket|message|post|send|publish|supplier|call|phone|app|connected/.test(text)) {
    for (const tool of ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"]) selected.add(tool);
  }
  if (/browser|website|web page|click|form|login/.test(text)) selected.add("CHUCK_BROWSER");
  if (/build|code|develop|deploy|landing page|test suite|run tests|run the tests|repository|repo/.test(text)) {
    selected.add("CHUCK_DAYTONA_EXECUTE");
    selected.add("CHUCK_DAYTONA_WORKSPACE");
  }
  if (/image|photo|logo|poster|flyer|illustration/.test(text)) selected.add("CHUCK_GENERATE_IMAGE");
  if (/video|clip|film|animation/.test(text)) selected.add("CHUCK_GENERATE_VIDEO");
  if (/spreadsheet|workbook|excel/.test(text)) selected.add("CHUCK_CREATE_SPREADSHEET");
  if (/presentation|powerpoint|slide|deck/.test(text)) selected.add("CHUCK_CREATE_PRESENTATION");
  if (/document|docx/.test(text)) selected.add("CHUCK_CREATE_DOCUMENT");
  if (/pdf|report/.test(text)) selected.add("CHUCK_CREATE_PDF");
  if (/memory|remember|profile|preference/.test(text)) selected.add("CHUCK_MEMORY_BRIEF");
  if (/research|search|latest|current|competitor|company|person|seo/.test(text)) {
    selected.add("CHUCK_TREG_SEARCH");
    selected.add("COMPOSIO_SEARCH_WEB");
    selected.add("COMPOSIO_SEARCH_FETCH_URL_CONTENT");
  }
  if (/\bmonid\b/.test(text)) {
    for (const tool of ["CHUCK_MONID_SEARCH", "CHUCK_MONID_INSPECT", "CHUCK_MONID_RUN", "CHUCK_MONID_RUN_GET", "CHUCK_MONID_RUNS_LIST", "CHUCK_MONID_STOP", "CHUCK_MONID_BALANCE", "CHUCK_MONID_USAGE"]) selected.add(tool);
  }
  return selected.size ? ["CHUCK_FIND_TOOLS", ...selected] : [];
}

export function missionWorkerToolAllowlist(stepTools?: string[], inheritedTools?: string[]): string[] | undefined {
  if (stepTools === undefined) return inheritedTools;
  const inherited = inheritedTools ? new Set(inheritedTools) : undefined;
  const selected = new Set(stepTools.filter((tool) => !inherited || inherited.has(tool)));
  const controls = stepTools.length === 0
    ? MISSION_WORKER_CONTROL_TOOLS.filter((tool) => tool !== "CHUCK_MISSION_VERIFY")
    : MISSION_WORKER_CONTROL_TOOLS;
  // Image-bearing provider actions cannot use the batch executor: the media
  // bridge must stage the file and verify the exact provider receipt through
  // the single-action path. Keep both meta-tools available whenever a mission
  // step requests batching so a model retry is not blocked by an incomplete
  // permission fence.
  if (selected.has("COMPOSIO_MULTI_EXECUTE_TOOL")) selected.add("COMPOSIO_EXECUTE_TOOL");
  // Explicit mission steps may name an exact connected-app action while the
  // owner's ToolRouter session exposes only gateway schemas. The planner
  // strips COMPOSIO_EXECUTE_TOOL from persisted step fences because it is
  // supervisor-owned, so restore the narrow single-action gateway at worker
  // runtime whenever the step grants at least one exact provider action.
  // The action fence is still enforced by the agent: the gateway can execute
  // only a discovered action present in this step's exact allowlist.
  const hasExactProviderAction = [...selected].some((tool) =>
    /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(tool)
    && !tool.startsWith("CHUCK_")
    && !tool.startsWith("COMPOSIO_")
    && !tool.startsWith("MCP_"),
  );
  if (hasExactProviderAction) selected.add("COMPOSIO_EXECUTE_TOOL");
  return [...new Set([...controls, ...selected])];
}

/** A model-driven replan cannot widen the tool fence of the step that caused it. */
export function constrainMissionReplanTools<T extends { allowedTools?: string[] }>(steps: readonly T[], currentAllowedTools?: readonly string[]): T[] {
  if (currentAllowedTools === undefined) return steps.map((step) => ({ ...step }));
  const allowed = new Set(currentAllowedTools);
  return steps.map((step) => ({
    ...step,
    // Model replans sometimes emit an empty array when they mean “use the
    // existing mission authority.” Treat that as inheritance only when a
    // non-empty parent fence exists. An explicitly fenced non-empty list is
    // still narrowed to the parent authority, so a replan cannot widen it.
    allowedTools: (step.allowedTools?.length ? step.allowedTools : [...allowed]).filter((tool) => allowed.has(tool)),
  }));
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
  if (!step) return "Determine the next concrete mission action from the persisted checkpoint, then execute it now. For a timer wait, use CHUCK_TASK_WAIT, never a fabricated provider event.";
  return `Execute only this mission step now: ${step.title}\nStep objective: ${step.objective}\nIf this step needs a timed wait, use CHUCK_TASK_WAIT and include the post-wake verification/action in this same step; persist nextAction as the action after wake, never as another wait. Use CHUCK_MISSION_WAIT_EVENT only for a real external provider callback. Do not summarize the remaining mission or defer this step to another worker. Persist the result, evidence, checkpoint, wait, block, or step completion before ending this slice.`;
}

/** Resolve a timer wake target from the latest persisted mission frontier. */
export function missionTimerResumeStep(
  mission: Pick<MissionRecord, "steps" | "activeStepIds" | "currentStepId">,
  preferredStepId?: string,
): MissionStepRecord | undefined {
  const activeStepIds = new Set(mission.activeStepIds ?? []);
  if (preferredStepId && activeStepIds.has(preferredStepId)) {
    const preferred = mission.steps.find((step) => step.id === preferredStepId && step.status === "running");
    if (preferred) return preferred;
  }
  const current = mission.currentStepId && activeStepIds.has(mission.currentStepId)
    ? mission.steps.find((step) => step.id === mission.currentStepId && step.status === "running")
    : undefined;
  if (current) return current;
  return (mission.activeStepIds ?? [])
    .map((stepId) => mission.steps.find((step) => step.id === stepId && step.status === "running"))
    .find((step): step is MissionStepRecord => Boolean(step));
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
  _requestedNextAction?: string,
): string {
  if (!step) return "The durable timer is due, but the saved continuation has no active step. Reconcile the mission frontier before running work.";
  return `After the durable timer wakes, resume only active mission step “${step.title}”: ${step.objective} Do not repeat completed steps. Do not call CHUCK_TASK_WAIT again for this timer. Persist the post-wake result and complete this step only when its objective is verified.`.slice(0, 2000);
}

/** A timer wake with no tool call is safe to retry once inside the same slice. */
export function missionWakeNeedsRecovery(
  resumed: boolean,
  result: { toolsUsed: string[]; taskWait?: unknown; missionWait?: unknown },
): boolean {
  return resumed && result.toolsUsed.length === 0 && !result.taskWait && !result.missionWait;
}

/**
 * A model can persist evidence or a checkpoint and then stop at prose. That
 * is durable progress, but it is not a terminating step transition. Give the
 * same worker one bounded lifecycle-only follow-up so a weak model cannot
 * strand a running mission after useful work is already persisted.
 */
export function missionNeedsLifecycleCloseoutNudge(result: {
  toolsUsed: string[];
  toolsSucceeded?: string[];
  taskWait?: unknown;
  missionWait?: unknown;
}): boolean {
  if (result.taskWait || result.missionWait) return false;
  const succeeded = new Set(result.toolsSucceeded ?? []);
  const persistedProgress = [
    "CHUCK_MISSION_CHECKPOINT",
    "CHUCK_MISSION_EVIDENCE",
    "CHUCK_MISSION_VERIFY",
  ].some((tool) => succeeded.has(tool));
  const terminalOrWait = [
    "CHUCK_MISSION_STEP_COMPLETE",
    "CHUCK_MISSION_COMPLETE",
    "CHUCK_MISSION_BLOCK",
    "CHUCK_MISSION_PAUSE",
    "CHUCK_MISSION_WAIT_EVENT",
    "CHUCK_TASK_WAIT",
  ].some((tool) => succeeded.has(tool));
  return persistedProgress && !terminalOrWait;
}

/**
 * A supervisor may resume a timer-waiting mission before its durable worker
 * claims the task. Keep the wake marker visible to that worker so it receives
 * post-wake instructions instead of treating the resumed mission as a fresh
 * first slice.
 */
export function missionHasTimerWakeContinuation(
  mission?: Pick<MissionRecord, "status" | "events" | "currentStepId" | "activeStepIds"> & { steps?: Array<Pick<MissionStepRecord, "id" | "status">> },
  missionStepId?: string,
): boolean {
  if (!mission || mission.status !== "running") return false;
  const requestedStepIsActive = Boolean(missionStepId && mission.activeStepIds?.includes(missionStepId));
  const requestedStepCompleted = Boolean(missionStepId && mission.steps?.some((step) => step.id === missionStepId && step.status === "completed"));
  // Timer waits can be requested after the model completes its original step
  // in the same turn. In that case the same durable task resumes on the new
  // active frontier, while its immutable task record still names the old step.
  const stepId = requestedStepIsActive
    ? missionStepId
    : requestedStepCompleted
      ? mission.currentStepId ?? mission.activeStepIds?.[0]
      : missionStepId ?? mission.currentStepId ?? mission.activeStepIds?.[0];
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
    // Scheduler reconciliation may append step_started after the wake and
    // before the same durable task is claimed. It is coordination metadata,
    // not post-wake mission progress; never let it consume the wake marker.
    if (event.type === "step_started") continue;
    if (terminalOrProgressEvents.has(event.type)) return false;
  }
  return false;
}
