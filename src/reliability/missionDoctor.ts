import type { CompensationRecord } from "./contracts.js";
import type { MissionRecord, TaskRecord } from "../store.js";

export interface MissionDoctorTask {
  id: string;
  status: TaskRecord["status"];
  stepId?: string;
  attempt: number;
  maxAttempts: number;
  runAt?: number;
  error?: string;
  nextAction?: string;
  lastFailureClass?: TaskRecord["lastFailureClass"];
  lease?: { workerId: string; expiresAt: number; expired: boolean };
}

export interface MissionDoctorReport {
  missionId: string;
  status: MissionRecord["status"];
  generatedAt: number;
  health: "healthy" | "waiting" | "stalled" | "blocked" | "terminal";
  summary: string;
  reasons: string[];
  nextActions: string[];
  readyStepIds: string[];
  activeStepIds: string[];
  waiting?: MissionRecord["waiting"] & { overdue: boolean };
  tasks: MissionDoctorTask[];
  compensation: { pending: number; blocked: number };
  budget: {
    consumedSteps: number;
    maxSteps: number;
    remainingSteps: number;
    consumedSlices: number;
    maxSlices?: number;
    remainingSlices?: number;
    toolCalls: number;
    maxToolCalls: number;
    remainingToolCalls: number;
    cost: number;
    maxCost: number;
    remainingCost: number;
    durationMode: "active" | "wall_clock";
    elapsedSeconds: number;
    maxDurationSeconds: number;
    remainingDurationSeconds: number;
  };
  workSchedule?: MissionRecord["workSchedule"];
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function elapsedSeconds(mission: MissionRecord, now: number): number {
  if (mission.timing) {
    const activeMs = mission.timing.activeMs + (mission.timing.activeSince ? Math.max(0, now - mission.timing.activeSince) : 0);
    return Math.max(0, Math.floor(activeMs / 1000));
  }
  return Math.max(0, Math.floor((now - (mission.startedAt ?? mission.createdAt)) / 1000));
}

function readySteps(mission: MissionRecord): string[] {
  const completed = new Set(mission.steps.filter((step) => step.status === "completed").map((step) => step.id));
  return mission.steps.filter((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency))).map((step) => step.id);
}

/**
 * Produce a bounded, deterministic explanation of why a mission is or is not
 * advancing. This is intentionally read-only: it never repairs, retries, or
 * publishes work, so it is safe to expose to operators and SDK clients.
 */
export function diagnoseMission(input: { mission: MissionRecord; tasks: TaskRecord[]; compensations?: CompensationRecord[]; now?: number }): MissionDoctorReport {
  const now = input.now ?? Date.now();
  const mission = input.mission;
  const missionTasks = input.tasks.filter((task) => task.missionId === mission.id);
  const ready = readySteps(mission);
  const reasons: string[] = [];
  const nextActions: string[] = [];
  const pendingCompensations = (input.compensations ?? []).filter((item) => item.missionId === mission.id && item.status === "pending").length;
  const blockedCompensations = (input.compensations ?? []).filter((item) => item.missionId === mission.id && item.status === "blocked").length;
  const tasks = missionTasks.slice(0, 50).map((task): MissionDoctorTask => ({
    id: task.id,
    status: task.status,
    ...(task.missionStepId ? { stepId: task.missionStepId } : {}),
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    ...(task.runAt !== undefined ? { runAt: task.runAt } : {}),
    ...(bounded(task.error, 1000) ? { error: bounded(task.error, 1000) } : {}),
    ...(bounded(task.nextAction, 1000) ? { nextAction: bounded(task.nextAction, 1000) } : {}),
    ...(task.lastFailureClass ? { lastFailureClass: task.lastFailureClass } : {}),
    ...(task.lease ? { lease: { workerId: task.lease.workerId, expiresAt: task.lease.expiresAt, expired: task.lease.expiresAt <= now } } : {}),
  }));
  const expiredLeases = missionTasks.filter((task) => task.lease && task.lease.expiresAt <= now);
  const failedTasks = missionTasks.filter((task) => task.status === "failed" || task.status === "blocked");
  const waiting = mission.waiting ? { ...mission.waiting, overdue: (mission.waiting.expiresAt ?? Number.POSITIVE_INFINITY) <= now || (mission.waiting.runAt ?? Number.POSITIVE_INFINITY) <= now } : undefined;
  const queuedOrRunning = missionTasks.filter((task) => task.status === "queued" || task.status === "running");
  const budget = mission.budget;
  const elapsed = elapsedSeconds(mission, now);
  const durationMode = budget.durationMode ?? "wall_clock";
  const remainingDurationSeconds = Math.max(0, budget.maxDurationSeconds - elapsed);
  const remainingSlices = budget.maxSlices === undefined ? undefined : Math.max(0, budget.maxSlices - (mission.consumedSlices ?? 0));
  const reportBudget = {
    consumedSteps: mission.consumedSteps,
    maxSteps: budget.maxSteps,
    remainingSteps: Math.max(0, budget.maxSteps - mission.consumedSteps),
    consumedSlices: mission.consumedSlices ?? 0,
    ...(budget.maxSlices === undefined ? {} : { maxSlices: budget.maxSlices, remainingSlices }),
    toolCalls: mission.toolCalls,
    maxToolCalls: budget.maxToolCalls,
    remainingToolCalls: Math.max(0, budget.maxToolCalls - mission.toolCalls),
    cost: mission.cost,
    maxCost: budget.maxCost,
    remainingCost: Math.max(0, budget.maxCost - mission.cost),
    durationMode,
    elapsedSeconds: elapsed,
    maxDurationSeconds: budget.maxDurationSeconds,
    remainingDurationSeconds,
  };

  if (["completed", "cancelled"].includes(mission.status)) {
    return { missionId: mission.id, status: mission.status, generatedAt: now, health: "terminal", summary: `Mission is ${mission.status}.`, reasons: [], nextActions: [], readyStepIds: ready, activeStepIds: mission.activeStepIds ?? [], ...(waiting ? { waiting } : {}), tasks, compensation: { pending: pendingCompensations, blocked: blockedCompensations }, budget: reportBudget, ...(mission.workSchedule ? { workSchedule: mission.workSchedule } : {}) };
  }
  if (mission.status === "failed" || mission.status === "blocked" || failedTasks.length || blockedCompensations) {
    if (mission.status === "failed" || mission.status === "blocked") reasons.push(`mission_${mission.status}`);
    if (failedTasks.length) reasons.push("task_failed_or_blocked");
    if (blockedCompensations) reasons.push("compensation_blocked");
    if (failedTasks.some((task) => task.lastFailureClass === "provider_uncertain")) reasons.push("provider_outcome_uncertain");
    const failedTaskAction = failedTasks.map((task) => bounded(task.nextAction, 1000)).find(Boolean);
    nextActions.push(blockedCompensations ? "Review the blocked compensation and reconcile provider state before resuming." : failedTaskAction ?? "Inspect the failed task and provider receipt, then repair or resume from the saved checkpoint.");
  }
  if (expiredLeases.length) {
    reasons.push("expired_worker_lease");
    const nativeOnlyExpiredLease = expiredLeases.some((task) => task.missionAllowedTools?.length && task.missionAllowedTools.every((tool) => tool.startsWith("CHUCK_")));
    nextActions.push(nativeOnlyExpiredLease
      ? "Review the saved checkpoint and task events, then repair or resume the native-only step explicitly; no provider receipt is expected."
      : "Run mission recovery to reclaim the expired lease and reschedule the saved slice only after provider state is reconciled.");
  }
  if (waiting) {
    reasons.push(waiting.overdue ? "wait_is_due_or_expired" : `waiting_for_${waiting.kind}`);
    nextActions.push(waiting.kind === "provider_event" ? "Deliver the exact signed provider event, or inspect the provider state if the event is lost." : waiting.kind === "approval" ? "Approve or deny the pending mission action." : waiting.kind === "timer" ? "Resume the mission after the durable timer wake." : "Provide the requested human input, then resume the mission.");
  } else if (mission.status === "running" && !queuedOrRunning.length && ready.length) {
    reasons.push("running_without_a_live_task");
    nextActions.push("Run mission recovery to schedule the dependency-ready step.");
  }
  if (!remainingDurationSeconds || !reportBudget.remainingSteps || !reportBudget.remainingToolCalls || !reportBudget.remainingCost || remainingSlices === 0) {
    reasons.push("mission_budget_exhausted");
    nextActions.push("Reduce the remaining plan or request an approved budget extension before resuming.");
  }
  const health: MissionDoctorReport["health"] = mission.status === "blocked" || mission.status === "failed" || blockedCompensations ? "blocked" : waiting ? "waiting" : reasons.length ? "stalled" : "healthy";
  const summary = health === "healthy" ? "Mission has a live executable path." : health === "waiting" ? `Mission is waiting for ${waiting?.kind ?? "an external condition"}.` : health === "stalled" ? "Mission is active but has no healthy forward execution path." : "Mission requires intervention before it can safely continue.";
  return { missionId: mission.id, status: mission.status, generatedAt: now, health, summary, reasons: [...new Set(reasons)].slice(0, 20), nextActions: [...new Set(nextActions)].slice(0, 10), readyStepIds: ready.slice(0, 200), activeStepIds: (mission.activeStepIds ?? []).slice(0, 200), ...(waiting ? { waiting } : {}), tasks, compensation: { pending: pendingCompensations, blocked: blockedCompensations }, budget: reportBudget, ...(mission.workSchedule ? { workSchedule: mission.workSchedule } : {}) };
}
