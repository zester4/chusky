import { createHash } from "node:crypto";
import {
  cancelTask,
  completeMissionStep,
  createTask,
  finalizeMissionIfReady,
  getMission,
  listTasks,
  recordMissionEvidence,
  replanMission,
  resumeMission,
  resumeMissionFromTimer,
  extendMissionDurationIfEligible,
  retryTask,
  updateTask,
  updateMission,
  verifyMission,
  type MissionRecord,
} from "./store.js";
import { enqueueTaskWithClaim } from "./taskEnqueue.js";

/** Enqueue one durable task through the caller's workflow provider. */
export type MissionTaskEnqueuer = (userId: number, taskId: string, runAt: number) => Promise<string>;

const MAX_MISSION_PLAN_STEPS = 1000;

function localParts(at: Date, timezone: string): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: value.year, month: value.month, day: value.day, minutes: value.hour * 60 + value.minute };
}

function zonedLocalToUtc(year: number, month: number, day: number, minutes: number, timezone: string): number {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let result = naive;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = localParts(new Date(result), timezone);
    const desired = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
    const observed = Date.UTC(actual.year, actual.month - 1, actual.day, Math.floor(actual.minutes / 60), actual.minutes % 60);
    result += desired - observed;
  }
  return result;
}

/** Return the next instant at which a scheduled mission may execute. */
export function nextMissionWorkAt(schedule: MissionRecord["workSchedule"], now = Date.now()): number {
  if (!schedule) return now;
  const current = localParts(new Date(now), schedule.timezone);
  const start = Number(schedule.windowStart.slice(0, 2)) * 60 + Number(schedule.windowStart.slice(3));
  const end = Number(schedule.windowEnd.slice(0, 2)) * 60 + Number(schedule.windowEnd.slice(3));
  const currentDayStart = zonedLocalToUtc(current.year, current.month, current.day, start, schedule.timezone);
  const currentDayEnd = zonedLocalToUtc(current.year, current.month, current.day, end, schedule.timezone);
  if (now < currentDayStart) return currentDayStart;
  // Do not start a fresh slice when less than one configured cadence remains;
  // otherwise a step completed at the end of a window creates a same-day
  // hot loop instead of resting until the next durable work window.
  if (now < currentDayEnd && now + schedule.cadenceSeconds * 1000 <= currentDayEnd) return now;
  const nextLocal = new Date(Date.UTC(current.year, current.month - 1, current.day) + 86400000);
  return zonedLocalToUtc(nextLocal.getUTCFullYear(), nextLocal.getUTCMonth() + 1, nextLocal.getUTCDate(), start, schedule.timezone);
}

/** Move queued active branches after a schedule edit without touching a live lease. */
export async function rescheduleQueuedMissionTasks(userId: number, mission: MissionRecord, now = Date.now()): Promise<void> {
  if (mission.status !== "running") return;
  const active = new Set(mission.activeStepIds?.length ? mission.activeStepIds : mission.currentStepId ? [mission.currentStepId] : []);
  const runAt = nextMissionWorkAt(mission.workSchedule, now);
  const tasks = await listTasks(userId);
  await Promise.all(tasks
    .filter((task) => task.missionId === mission.id && task.status === "queued" && active.has(task.missionStepId ?? ""))
    .map((task) => updateMissionTaskSchedule(userId, task.id, runAt)));
}

async function updateMissionTaskSchedule(userId: number, taskId: string, runAt: number): Promise<void> {
  await updateTask(userId, taskId, {
    runAt,
    // The old provider delivery may still arrive. Clearing its publication
    // marker makes the task eligible for one fresh publication, while the
    // task lease/CAS prevents the old and new deliveries from both executing.
    workflowRunId: undefined,
    workflowPublishedAt: undefined,
    enqueueClaim: undefined,
  });
}

/** Validate step payloads before transport adapters normalize or omit fields. */
export function validateMissionStepsPayload(raw: unknown, options: { requireNonEmpty?: boolean } = {}): string | undefined {
  if (raw === undefined) return options.requireNonEmpty ? "At least one mission step is required." : undefined;
  if (!Array.isArray(raw)) return "Mission steps must be an array.";
  if (raw.length > MAX_MISSION_PLAN_STEPS) return `Mission plans can contain at most ${MAX_MISSION_PLAN_STEPS} steps.`;
  if (options.requireNonEmpty && raw.length === 0) return "At least one mission step is required.";

  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `Mission step ${index + 1} must be an object.`;
    const step = value as Record<string, unknown>;
    if (typeof step.title !== "string" || !step.title.trim() || step.title.length > 240) return `Mission step ${index + 1} needs a title of 1 to 240 characters.`;
    if (typeof step.objective !== "string" || !step.objective.trim() || step.objective.length > 4000) return `Mission step ${index + 1} needs an objective of 1 to 4000 characters.`;
    if (step.id !== undefined && (typeof step.id !== "string" || !step.id.trim() || step.id.trim().length > 160)) return `Mission step ${index + 1} has an invalid ID.`;
    if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.length > 20 || step.dependsOn.some((dependency) => typeof dependency !== "string" || !dependency.trim() || dependency.trim().length > 160))) return `Mission step ${index + 1} has invalid dependencies.`;
    if (step.retryLimit !== undefined && (typeof step.retryLimit !== "number" || !Number.isInteger(step.retryLimit) || step.retryLimit < 0 || step.retryLimit > 20)) return `Mission step ${index + 1} has an invalid retry limit.`;
    if (step.allowedTools !== undefined && (!Array.isArray(step.allowedTools) || step.allowedTools.length > 100 || step.allowedTools.some((tool) => typeof tool !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool) || /^CHUCK_MISSION_|^CHUCK_TASK_|^COMPOSIO_(?:EXECUTE_TOOL|MULTI_EXECUTE_TOOL)$/.test(tool)))) return `Mission step ${index + 1} has an invalid or supervisor-owned allowed tool.`;
  }
  return undefined;
}

export class MissionEnqueueError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MissionEnqueueError";
  }
}

/** Reconcile a mission's durable work after a state transition or retry. */
export async function reconcileMissionExecution(userId: number, missionId: string, enqueue: MissionTaskEnqueuer, preserveTaskId?: string): Promise<MissionRecord | undefined> {
  const current = await getMission(userId, missionId);
  if (!current || current.status !== "running") return current;
  const finalized = await finalizeMissionIfReady(userId, missionId, { blockOnUnresolved: true }) ?? current;
  if (finalized.status !== "running") return finalized;

  const active = new Set(finalized.activeStepIds?.length ? finalized.activeStepIds : finalized.currentStepId ? [finalized.currentStepId] : []);
  const obsoleteTasks = (await listTasks(userId)).filter((task) => task.missionId === missionId
    && task.missionStepId
    && task.id !== preserveTaskId
    && !["completed", "cancelled"].includes(task.status)
    && (!active.has(task.missionStepId) || finalized.steps.find((step) => step.id === task.missionStepId)?.status !== "running"));
  await Promise.all(obsoleteTasks.map((task) => cancelTask(userId, task.id)));

  let scheduled: MissionRecord | undefined;
  try {
    scheduled = await scheduleMissionSteps(userId, finalized, enqueue);
  } catch (error) {
    throw new MissionEnqueueError(error);
  }
  return await getMission(userId, missionId) ?? scheduled ?? finalized;
}

/** Idempotently resume or repair scheduling for a mission that is already running. */
export async function resumeMissionAndSchedule(userId: number, missionId: string, enqueue: MissionTaskEnqueuer, maxDurationSeconds?: number, budgetPatch?: import("./store.js").MissionBudget): Promise<MissionRecord | undefined> {
  const current = await getMission(userId, missionId);
  if (!current) return undefined;
  // A timer-waiting mission is already the owner of the correct durable task.
  // When its wake is overdue, resume that same mission/step instead of
  // rejecting it as non-resumable or creating a replacement task. A future
  // timer remains waiting and is returned unchanged.
  if (current.status === "waiting" && current.waiting?.kind === "timer") {
    const runAt = current.waiting.runAt;
    if (!runAt || runAt > Date.now()) return current;
    const resumedFromTimer = await resumeMissionFromTimer(userId, missionId, runAt);
    if (!resumedFromTimer) return await getMission(userId, missionId);
    if (resumedFromTimer.status !== "running") return resumedFromTimer;
    const resumed = maxDurationSeconds === undefined && !budgetPatch
      ? resumedFromTimer
      : await resumeMission(userId, missionId, maxDurationSeconds, budgetPatch);
    if (!resumed || resumed.status !== "running") return resumed ?? await getMission(userId, missionId);
    return reconcileMissionExecution(userId, missionId, enqueue);
  }
  if (maxDurationSeconds === undefined) await extendMissionDurationIfEligible(userId, missionId);
  const resumed = await resumeMission(userId, missionId, maxDurationSeconds, budgetPatch);
  if (!resumed) return undefined;
  if (resumed.status !== "running") return resumed;
  return reconcileMissionExecution(userId, missionId, enqueue);
}

/** Complete one active step, close out if ready, and enqueue all newly-ready branches. */
export async function completeMissionStepAndAdvance(userId: number, missionId: string, stepId: string, result: string, enqueue: MissionTaskEnqueuer, preserveTaskId?: string): Promise<MissionRecord | undefined> {
  const completed = await completeMissionStep(userId, missionId, stepId, result);
  if (!completed) return undefined;
  return reconcileMissionExecution(userId, missionId, enqueue, preserveTaskId);
}

/** Close out completed work after explicit verification or trusted evidence arrives. */
export async function finalizeMissionCloseout(userId: number, missionId: string): Promise<MissionRecord | undefined> {
  let mission = await getMission(userId, missionId);
  if (!mission || mission.steps.some((step) => step.status !== "completed") || !["running", "blocked"].includes(mission.status)) return mission;
  if (mission.status === "blocked") {
    if (mission.verification?.mode === "strict") {
      mission = await verifyMission(userId, missionId) ?? mission;
      if (!mission.verification?.verified) return mission;
    }
    mission = await resumeMission(userId, missionId) ?? mission;
  }
  if (mission.status !== "running") return mission;
  return await finalizeMissionIfReady(userId, missionId, { blockOnUnresolved: true }) ?? mission;
}

/** Re-check closeout immediately when late evidence resolves a completed mission. */
export async function recordMissionEvidenceAndCloseout(userId: number, missionId: string, evidence: Parameters<typeof recordMissionEvidence>[2], stepId?: string): Promise<MissionRecord | undefined> {
  const mission = await recordMissionEvidence(userId, missionId, evidence, stepId);
  if (!mission) return undefined;
  return await finalizeMissionCloseout(userId, missionId) ?? mission;
}

/** Apply a validated replan and reconcile its ready tasks without stale task IDs. */
export async function replanMissionAndSchedule(userId: number, missionId: string, steps: Array<{ id?: string; title: string; objective: string; dependsOn?: string[]; retryLimit?: number; allowedTools?: string[] }>, reason: string, enqueue: MissionTaskEnqueuer, preserveTaskId?: string): Promise<MissionRecord | undefined> {
  const replanned = await replanMission(userId, missionId, steps, reason);
  if (!replanned) return undefined;
  return reconcileMissionExecution(userId, missionId, enqueue, preserveTaskId);
}

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
  const taskAttempts = new Map<string, number>();
  const enqueuedStepIds = new Set<string>();
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
        // The worker receives one executable step, not the supervisor's
        // plan-level nextAction. This also gives operators a useful recovery
        // instruction before the first slice has run.
        nextAction: step.objective,
        missionId: current.id,
        missionStepId: stepId,
        missionAllowedTools: step.allowedTools,
        runAt: nextMissionWorkAt(current.workSchedule, now),
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
    // A persisted provider ID normally suppresses replay. Reconsider it only
    // after a durable outage window, covering accepted-but-lost deliveries
    // without making an immediate resume publish a duplicate.
    const overduePublished = task.status === "queued" && typeof task.runAt === "number" && task.runAt <= now && Boolean(task.workflowRunId) && !task.workflowRunId?.startsWith("pending:")
      && typeof task.workflowPublishedAt === "number" && now - task.workflowPublishedAt >= 60_000;
    if (shouldEnqueue || (task.status === "queued" && (!task.workflowRunId || pendingClaimExpired || overduePublished))) {
      const workflowRunId = await enqueueTaskWithClaim(userId, task.id, task.runAt ?? now, enqueue);
      if (workflowRunId) enqueuedStepIds.add(stepId);
    }
    assigned.set(stepId, task.id);
    taskAttempts.set(stepId, task.attempt);
  }
  if (!assigned.size) return current;
  const linked = await updateMission(userId, current.id, (latest) => {
    if (["completed", "cancelled"].includes(latest.status)) return undefined;
    const activeAssignments = new Map([...assigned].filter(([stepId]) => latest.steps.some((step) => step.id === stepId && step.status === "running")));
    if (!activeAssignments.size) return undefined;
    const changedStepIds = [...activeAssignments].flatMap(([stepId, taskId]) => {
      const step = latest.steps.find((candidate) => candidate.id === stepId);
      return step?.taskId === taskId ? [] : [stepId];
    });
    const rootTaskId = latest.rootTaskId ?? activeAssignments.values().next().value;
    if (!rootTaskId) return undefined;
    const rootTaskChanged = rootTaskId !== latest.rootTaskId;
    if (!changedStepIds.length && !rootTaskChanged && !enqueuedStepIds.size) return undefined;
    const eventStepIds = [...new Set([...changedStepIds, ...[...enqueuedStepIds].filter((stepId) => activeAssignments.has(stepId))])].sort();
    const eventTaskAttempts = eventStepIds.map((stepId) => `${stepId}:${activeAssignments.get(stepId) ?? assigned.get(stepId)}:${taskAttempts.get(stepId) ?? 0}`).sort();
    const eventId = `misevt_${createHash("sha256").update(`${latest.id}:schedule:${eventTaskAttempts.join(",")}`).digest("hex").slice(0, 24)}`;
    const events = eventStepIds.length && !latest.events.some((event) => event.id === eventId)
      ? [...latest.events, {
        id: eventId,
        type: "step_started" as const,
        message: `Reconciled ${eventStepIds.length} dependency-ready mission task${eventStepIds.length === 1 ? "" : "s"}.`,
        at: now,
        metadata: { stepCount: eventStepIds.length, stepIds: eventStepIds.join(",") },
      }]
      : latest.events;
    return {
      rootTaskId,
      steps: latest.steps.map((step) => activeAssignments.has(step.id) && step.status === "running" && step.taskId !== activeAssignments.get(step.id)
        ? { ...step, taskId: activeAssignments.get(step.id), updatedAt: now }
        : step),
      events,
    };
  });
  return linked ?? current;
}
