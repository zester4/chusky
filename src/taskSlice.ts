import { extendMissionDurationIfEligible } from "./store.js";
import { config } from "./config.js";
import { appendSdkRunHistory, appendSdkRunHistoryToSession, getMeetingRepresentativeProfile } from "./store.js";
import { reserveExecutionQuota, releaseExecutionQuota } from "./reliability/quotas.js";
import { getTelegramChatId, getSession, getSessionWithSdkRuns, getSdkRun, saveSdkRun, saveSession, addUsage, canSpend, getApproval, getTask, getMission, isTaskCancellationRequested, recordMissionSlice, waitMission, resumeMissionFromTimer, checkpointMission, completeTask, updateTask, updateMission, acquireMissionLease, renewMissionLease, releaseMissionLease, acquireMissionStepLease, renewMissionStepLease, releaseMissionStepLease, missionBudgetPreflight, MISSION_ZERO_COST_BUDGET_ERROR, getRecallMeeting, getMeetingContact } from "./store.js";
import { runAgent as defaultRunAgent, ApprovalRequiredError } from "./agent.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import { reconcileMissionExecution } from "./missionScheduler.js";
import { executeScheduledMeetingFollowUp } from "./meetings/outcome.js";
import { decideAutonomyStep } from "./autonomy/decisionLoop.js";
import { boundedMissionHistory, captureMissionSliceState, missionHasTimerWakeContinuation, missionNeedsLifecycleCloseoutNudge, missionPostWakeNextAction, missionStepInstruction, missionTimerResumeStep, missionWakeNeedsRecovery, missionWorkerToolAllowlist } from "./missionWorker.js";
import { missionToolCallCount, settleMissionSlice } from "./missionSlice.js";
import { persistSdkCompanyRun, sdkRunArtifacts } from "./sdkApi.js";
import type { TaskRecord } from "./store.js";
import type { TaskRunResult } from "./taskRunner.js";
import type { ContentPart } from "./types.js";
import type { MissionTaskEnqueuer } from "./missionScheduler.js";

/** The mission-step lease must outlive a slow model turn and provider read-back. */
export const MISSION_STEP_LEASE_MS = 3 * 60_000;
export const MISSION_STEP_LEASE_RENEWAL_MS = 30_000;
// A bounded cancellation read keeps long-running workers cancellable without
// turning every active worker into a fixed-rate Redis traffic source. The
// workflow lease and task state remain the durable stop authorities.
const TASK_CANCELLATION_CHECK_MS = 60_000;

/** Update an SDK run in its durable row instead of rewriting the whole owner
 * session. The session fallback is retained for memory/legacy deployments. */
async function updateTaskSdkRun(
  task: TaskRecord,
  mutator: (run: NonNullable<Awaited<ReturnType<typeof getSdkRun>>>) => void,
  history?: Parameters<typeof appendSdkRunHistory>[3],
): Promise<NonNullable<Awaited<ReturnType<typeof getSdkRun>>> | undefined> {
  if (!task.sdkRunId || !task.sdkThreadId) return undefined;
  const direct = await getSdkRun(task.userId, task.sdkThreadId, task.sdkRunId);
  if (direct) {
    const next = structuredClone(direct);
    mutator(next);
    try {
      if (await saveSdkRun(task.userId, task.sdkThreadId, next)) {
        if (history?.length) await appendSdkRunHistory(task.userId, task.sdkThreadId, next.id, history);
        return next;
      }
    } catch (error) {
      logger.debug({ errorName: error instanceof Error ? error.name : "UnknownError", taskId: task.id, runId: task.sdkRunId }, "Direct task SDK run update unavailable; using legacy session projection");
    }
  }
  const current = await getSessionWithSdkRuns(task.userId, task.sdkThreadId);
  const thread = current.sdkThreads?.find((item) => item.id === task.sdkThreadId);
  const run = thread?.runs.find((item) => item.id === task.sdkRunId);
  if (!run) return undefined;
  mutator(run);
  if (history?.length) appendSdkRunHistoryToSession(current, task.sdkThreadId, run.id, history);
  await saveSession(task.userId, current);
  return run;
}

export interface TaskSliceContext {
  workflowRunId?: string;
  attempt: number;
  sdkTaskMessage(task: TaskRecord | undefined, missionInput?: string): Promise<string | ContentPart[]>;
  sdkTaskSkillInstructions(skills: string[] | undefined): Promise<string | undefined>;
  sdkDurationSeconds(value: string | undefined): number | undefined;
  withUserLock<T>(userId: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T>;
  sendMessage(chatId: number, text: string, options: { parse_mode: "HTML" }): Promise<unknown>;
  /** Injectable boundaries retain the production agent and publisher by default. */
  runAgent?: typeof defaultRunAgent;
  enqueueMissionTask?: MissionTaskEnqueuer;
}

/** One production worker slice. HTTP/workflow replay stays in the adapter. */
export async function executeTaskSlice(task: TaskRecord, leaseSignal: AbortSignal | undefined, context: TaskSliceContext): Promise<TaskRunResult> {
  const { sdkTaskMessage, sdkTaskSkillInstructions, sdkDurationSeconds, withUserLock } = context;
  const runAgent = context.runAgent ?? defaultRunAgent;
  const enqueueMissionTask = context.enqueueMissionTask ?? enqueueTaskWorkflow;
  let mission: Awaited<ReturnType<typeof getMission>>;
  try {
    mission = task.missionId ? await getMission(task.userId, task.missionId) : undefined;
    if (mission && ["running", "waiting"].includes(mission.status) && task.missionStepId) {
      const boundStep = mission.steps.find((step) => step.id === task.missionStepId);
      if (boundStep?.status === "completed") {
        if (mission.status === "waiting" && mission.waiting?.stepId === task.missionStepId) {
          const blocked = await updateMission(task.userId, mission.id, {
            status: "blocked",
            error: "A mission timer is bound to a step that was already completed.",
            nextAction: "Inspect the saved checkpoint, then resume or replan from the active step. The completed step will not be replayed.",
            waiting: undefined,
          });
          return { status: "blocked" as const, message: blocked?.error ?? "Mission timer step was already completed.", checkpoint: blocked?.checkpoint ?? mission.checkpoint, nextAction: blocked?.nextAction };
        }
        // Completing a step can enqueue its successor before the original
        // worker returns. Never let that old task execute the successor under
        // the completed step's lease; the successor has its own deterministic
        // task and lease.
        if (mission.status === "running") await reconcileMissionExecution(task.userId, mission.id, enqueueMissionTask, task.id);
        return {
          status: "completed" as const,
          message: `Mission step ${boundStep.title} was already completed; its task handed off to the active step scheduler.`,
          checkpoint: mission.checkpoint,
          nextAction: mission.nextAction,
        };
      }
    }
    let missionTimerResumed = false;
    let missionWakeCheckpoint: string | undefined;
    let missionWakeNextAction: string | undefined;
    if (mission && missionHasTimerWakeContinuation(mission, task.missionStepId)) {
      missionTimerResumed = true;
      missionWakeCheckpoint = mission.checkpoint;
      missionWakeNextAction = mission.nextAction ?? "Continue from the saved timer checkpoint.";
    }
    if (mission && ["paused", "blocked", "completed", "cancelled"].includes(mission.status)) {
      return { status: mission.status === "completed" ? "completed" as const : mission.status === "cancelled" ? "cancelled" as const : "blocked" as const, message: mission.result ?? mission.error ?? `Mission is ${mission.status}.`, result: mission.result, checkpoint: mission.checkpoint, nextAction: mission.nextAction };
    }
    if (mission?.status === "waiting") {
      const waiting = mission.waiting;
      if (waiting?.kind === "timer") {
        const runAt = waiting.runAt;
        if (!runAt) return { status: "blocked" as const, message: "Mission timer wait has no persisted wake-up time.", checkpoint: mission.checkpoint, nextAction: "Repair the mission timer checkpoint before resuming." };
        if (runAt > Date.now()) return { status: "queued" as const, waiting: true, message: mission.nextAction ?? "Mission is waiting for its timer.", checkpoint: mission.checkpoint, nextAction: mission.nextAction, runAt };
        missionWakeCheckpoint = mission.checkpoint;
        missionWakeNextAction = mission.nextAction ?? "Continue from the saved timer checkpoint.";
        const resumed = await resumeMissionFromTimer(task.userId, mission.id, runAt);
        if (!resumed) {
          const current = await getMission(task.userId, mission.id);
          if (!current || current.status !== "running") return { status: "blocked" as const, message: "The mission timer wake-up no longer matches its persisted wait.", checkpoint: current?.checkpoint ?? mission.checkpoint, nextAction: "Inspect the mission wait state before retrying." };
          mission = current;
        } else {
          mission = resumed;
          missionTimerResumed = true;
          // Keep the task's durable prompt aligned with the mission
          // frontier. The previous implementation left the task's
          // nextAction at the pre-wait text, so a wake could replay
          // the same checkpoint and park again.
          const resumedTask = await updateTask(task.userId, task.id, { checkpoint: mission.checkpoint, nextAction: mission.nextAction, error: undefined });
          if (resumedTask) task = resumedTask;
        }
      }
      if (mission.waiting?.kind === "provider_event") {
        const expiresAt = mission.waiting.expiresAt;
        if (expiresAt && expiresAt <= Date.now()) {
          const blocked = await updateMission(task.userId, mission.id, { status: "blocked", error: "The provider-event wait expired before the expected event arrived.", nextAction: "Reconcile the provider state, then resume or replan the mission." });
          return { status: "blocked" as const, message: blocked?.error ?? "Provider-event wait expired", checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
        }
        // A provider callback, not polling, resumes this task. If an
        // expiry exists, one durable wake checks it; otherwise the
        // task becomes blocked and the signed event route will retry it.
        if (expiresAt) return { status: "queued" as const, waiting: true, message: mission.nextAction ?? "Mission is waiting for a provider event.", checkpoint: mission.checkpoint, nextAction: mission.nextAction, runAt: expiresAt };
        return { status: "blocked" as const, message: mission.nextAction ?? "Mission is waiting for a provider event.", checkpoint: mission.checkpoint, nextAction: "Wait for the exact provider event; the mission will resume automatically when it arrives." };
      }
      if (mission.waiting?.kind === "approval") {
        const expiresAt = mission.waiting.expiresAt;
        if (expiresAt && expiresAt <= Date.now()) {
          const blocked = await updateMission(task.userId, mission.id, { status: "blocked", error: "The approval wait expired before a decision was recorded.", nextAction: "Review the exact pending action and resume or replan the mission." });
          return { status: "blocked" as const, message: blocked?.error ?? "Approval wait expired", checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
        }
        // Approval callbacks enqueue the original task immediately;
        // no background polling is needed while the owner decides.
        if (expiresAt) return { status: "queued" as const, waiting: true, message: mission.nextAction ?? "Mission is waiting for approval.", checkpoint: mission.checkpoint, nextAction: mission.nextAction, runAt: expiresAt };
        return { status: "blocked" as const, message: mission.nextAction ?? "Mission is waiting for approval.", checkpoint: mission.checkpoint, nextAction: "Approve or deny the exact pending action; the mission will resume automatically after approval." };
      }
      if (mission.waiting?.kind === "human_input") {
        return { status: "blocked", message: "Mission is waiting for owner input; no model or provider action was run.", checkpoint: mission.checkpoint, nextAction: mission.nextAction ?? "Supply the missing owner input, then resume this same mission." };
      }
      // Only a validated timer wake may turn a waiting mission into running
      // here. Missing or future wait kinds must never implicitly grant work.
      if (mission.status === "waiting") {
        return { status: "blocked", message: "Mission has an unsupported or missing persisted wait condition.", checkpoint: mission.checkpoint, nextAction: "Repair the mission wait condition, then explicitly resume this same mission." };
      }
      await checkpointMission(task.userId, mission.id, mission.checkpoint ?? "The previous mission slice completed.", mission.nextAction);
    }
    const activeMission = mission;
    const currentMissionStep = activeMission
      ? task.missionStepId
        ? activeMission.steps.find((step) => step.id === task.missionStepId && step.status === "running" && activeMission.activeStepIds?.includes(step.id))
        : activeMission.steps.find((step) => step.status === "running" && activeMission.activeStepIds?.includes(step.id)) ?? activeMission.steps.find((step) => step.id === activeMission.currentStepId && step.status === "running")
      : undefined;
    const autonomyDecision = await decideAutonomyStep({
      objective: mission?.objective ?? task.objective,
      items: [{
        kind: mission ? "mission" : "task",
        id: mission?.id ?? task.id,
        title: mission ? mission.title : task.title,
        status: mission?.status ?? task.status,
        ...(mission?.nextAction ?? task.nextAction ? { nextAction: mission?.nextAction ?? task.nextAction } : {}),
      }],
      context: {
        objective: mission?.objective ?? task.objective,
        status: mission?.status ?? task.status,
        checkpoint: mission?.checkpoint ?? task.checkpoint,
        nextAction: mission?.nextAction ?? task.nextAction,
        definitionOfDone: mission?.definitionOfDone,
        currentStep: currentMissionStep?.objective,
      },
      authority: { level: mission ? "execute_reversible" : "prepare" },
      allowedActions: mission
        ? ["act_now", "wait", "replan", "retry", "ask_owner", "close_loop"]
        : ["act_now", "wait", "retry", "ask_owner", "close_loop"],
      maxItems: 1,
    });
    const autonomyGuidance = `\n\nTyped autonomy proposal (not authority): ${autonomyDecision.proposedAction}; effective policy action: ${autonomyDecision.effectiveAction}. Continue only within the current checkpoint, budget, account scope, approval state, and verification rules. If the proposal is wait, replan, retry, or ask_owner, follow the matching durable lifecycle control rather than improvising.`;
    const wakeContinuation = missionTimerResumed
      ? `WAKE CONTINUATION CONTRACT: The persisted timer wait has completed, including when a supervisor resumed it before this worker claimed the task. The old persisted nextAction may describe the whole remaining plan; use the active step objective and checkpoint as the authoritative post-wake work. Do not repeat the pre-wait checkpoint or call CHUCK_TASK_WAIT again. A text-only response is invalid: make an executable native or provider tool call in this slice. If this step requires a post-wake checkpoint and step completion, persist that checkpoint and then complete this active step; if it requires a provider read, perform that read now. Do not summarize or defer.`
      : "";
    const trustedNow = Date.now();
    const trustedIso = new Date(trustedNow).toISOString();
    const missionPrompt = mission ? `Continue autonomous mission ${mission.id}: ${mission.objective}\n\n${missionStepInstruction(currentMissionStep)}\nDefinition of done: ${mission.definitionOfDone}\n\nVerified checkpoint: ${mission.checkpoint ?? "none"}\nPersisted next action: ${mission.nextAction ?? task.nextAction ?? "Execute the current step's concrete objective."}\nTrusted runtime time: ${trustedIso} (epochMs ${trustedNow}). Copy this ISO value verbatim when a checkpoint needs a timestamp; never manually convert epoch values or invent lease expiry metadata. Lease state returned by CHUCK_MISSION_GET or CHUCK_MISSION_PROOF is authoritative.\n${wakeContinuation}\nBudget consumed: ${mission.consumedSlices ?? 0} worker slices and ${mission.consumedSteps} completed plan steps, ${mission.toolCalls} tool calls, $${mission.cost.toFixed(4)}\n\nWork one bounded slice now. Use CHUCK_MISSION_STEP_COMPLETE only once, only after the current active step is verified; after it succeeds, do not call it again for that step (a delivery replay preserves the original result). Use CHUCK_MISSION_CHECKPOINT after meaningful progress. Keep CHUCK_MISSION_* lifecycle controls with the supervisor: do not put them in a delegated specialist's allowedTools. Use CHUCK_TASK_WAIT for any bounded internal timer/delay, including an intentional mission timer; save the verified checkpoint and exact post-wake action, and never repeat the wait after wake. Use CHUCK_MISSION_WAIT_EVENT only for a real external provider callback with a stable event ID; never invent a timer provider/event. Omitted step dependencies mean sequential order; use explicit empty dependencies only for genuinely independent work. Keep a timer plus its post-wake verification in the same executable step. Use CHUCK_MISSION_COMPLETE only after the definition of done is verified. Use CHUCK_MISSION_PAUSE or CHUCK_MISSION_BLOCK when human input, permissions, or a dependency is required. Do not claim completion without evidence and do not perform risky external actions without the normal approval flow.${task.attempt > 1 ? "\n\nThe previous slice made no persisted progress. Do not return a summary: execute the step's concrete objective now, or persist an explicit block/wait with its reason." : ""}` : undefined;
    const prompt = task.sdkRunId ? await sdkTaskMessage(task) : missionPrompt && task.sdkAttachments?.length ? await sdkTaskMessage(task, missionPrompt + autonomyGuidance) : (missionPrompt ?? `Continue durable task ${task.id}: ${task.objective}\n\nLatest checkpoint: ${task.checkpoint ?? "none"}\nNext action: ${task.nextAction ?? "determine the safest next action"}\n\nUse task tools to checkpoint, block, or complete the task. If an external service is still processing, use CHUCK_TASK_WAIT with the verified checkpoint and exact next action; this pauses the same task without notifying the user and wakes it once. Do not perform risky external actions without the normal approval flow.`) + autonomyGuidance;
    const session = await getSession(task.userId, false, { domains: ["conversation"] });
    const agentHistory = mission ? boundedMissionHistory(session.history) : session.history;
    const parallelMission = Boolean(mission?.activeStepIds && mission.activeStepIds.length > 1);
    const missionRemainingSteps = mission ? mission.budget.maxSteps - mission.consumedSteps : undefined;
    const missionRemainingTools = mission ? mission.budget.maxToolCalls - mission.toolCalls : undefined;
    const missionRemainingCost = mission ? mission.budget.maxCost - mission.cost : undefined;
    if (mission) mission = await extendMissionDurationIfEligible(task.userId, mission.id) ?? mission;
    if (mission && mission.budget.maxCost <= 0) {
      const blocked = await updateMission(task.userId, mission.id, { status: "blocked", error: MISSION_ZERO_COST_BUDGET_ERROR, nextAction: "Resume with a positive model-execution budget; external provider actions can remain disabled." });
      return { status: "blocked" as const, message: blocked?.error ?? MISSION_ZERO_COST_BUDGET_ERROR, checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
    }
    if (mission && ((missionRemainingSteps ?? 1) <= 0 || (missionRemainingTools ?? 1) <= 0 || (missionRemainingCost ?? 1) <= 0)) {
      const blocked = await updateMission(task.userId, mission.id, { status: "blocked", error: "Mission budget is exhausted before the next slice.", nextAction: "Increase the mission budget or revise the objective before resuming." });
      return { status: "blocked" as const, message: blocked?.error ?? "Mission budget exhausted", checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
    }
    if (mission) {
      const preflight = missionBudgetPreflight(mission, { steps: 1, toolCalls: 1, cost: 0.0001, durationSeconds: 1 });
      if (!preflight.allowed) {
        const blocked = await updateMission(task.userId, mission.id, { status: "blocked", error: preflight.reason ?? "Mission budget preflight failed.", nextAction: "Increase the mission budget or revise the objective before resuming." });
        return { status: "blocked" as const, message: blocked?.error ?? "Mission budget preflight failed", checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
      }
    }
    let quotaReservationId: string | undefined;
    if (task.sdkRunId) {
      const admission = await reserveExecutionQuota(task.userId, "sdk.run", { maxConcurrent: 4 }, task.quotaReservationId ?? `quota_${task.id}`);
      if (!admission.allowed) return { status: "queued" as const, message: admission.reason ?? "Execution quota is temporarily full.", checkpoint: task.checkpoint, nextAction: "Retry when the owner's execution quota has capacity.", runAt: Date.now() + 30_000 };
      quotaReservationId = admission.reservationId;
    }
    let missionLeaseToken: string | undefined;
    const missionLeaseStepId = task.missionStepId;
    if (mission) {
      const workerId = `workflow:${context.workflowRunId ?? "task"}:${context.attempt}`;
      const leased = missionLeaseStepId
        ? await acquireMissionStepLease(task.userId, mission.id, missionLeaseStepId, workerId, MISSION_STEP_LEASE_MS)
        : await acquireMissionLease(task.userId, mission.id, workerId, MISSION_STEP_LEASE_MS);
      const acquiredLease = missionLeaseStepId ? leased?.executionLeases?.[missionLeaseStepId] : leased?.lease;
      if (!acquiredLease) { if (quotaReservationId) await releaseExecutionQuota(task.userId, quotaReservationId).catch(() => undefined); return { status: "queued" as const, message: "Another mission worker currently owns the execution lease.", checkpoint: mission.checkpoint, nextAction: "Retry after the active mission worker releases its lease.", runAt: Date.now() + 2000 }; }
      mission = leased;
      missionLeaseToken = acquiredLease.token;
    }
    const missionLeaseLost = mission ? new AbortController() : undefined;
    let missionLeaseRenewalFailures = 0;
    const missionLeaseRenewal = mission?.id && missionLeaseToken
      ? setInterval(() => {
        void (missionLeaseStepId
          ? renewMissionStepLease(task.userId, mission!.id, missionLeaseStepId, missionLeaseToken!, MISSION_STEP_LEASE_MS)
          : renewMissionLease(task.userId, mission!.id, missionLeaseToken!, MISSION_STEP_LEASE_MS)).then((renewed) => {
          if (renewed) {
            missionLeaseRenewalFailures = 0;
            return;
          }
          missionLeaseRenewalFailures += 1;
          if (missionLeaseRenewalFailures >= 2) missionLeaseLost?.abort(new Error("Mission lease was lost while the worker was executing."));
        }).catch((error) => {
          missionLeaseRenewalFailures += 1;
          logger.warn({ err: error, missionId: mission!.id, consecutiveFailures: missionLeaseRenewalFailures }, "Mission lease renewal failed");
          if (missionLeaseRenewalFailures >= 2) missionLeaseLost?.abort(new Error("Mission lease renewal failed repeatedly; stopping before another worker can continue."));
        });
      }, MISSION_STEP_LEASE_RENEWAL_MS)
      : undefined;
    // A detached timer is unsafe here: a workflow runtime can finish the
    // invocation's event loop while runAgent is awaiting a slow provider.
    const missionSliceBefore = captureMissionSliceState(task, mission);
    const durationSeconds = mission ? Math.max(1, Math.floor(missionBudgetPreflight(mission, { steps: 0 }).remaining.durationSeconds)) : task.composerBudgetSeconds ?? sdkDurationSeconds(task.sdkBudget?.duration);
    if (task.sdkRunId && durationSeconds && task.sdkStartedAt && Date.now() - task.sdkStartedAt >= durationSeconds * 1000) throw new Error("The configured SDK run duration budget has been exhausted.");
    if (task.sdkRunId && task.sdkThreadId) {
      const sdkRun = await updateTaskSdkRun(task, (run) => {
        if (run.status !== "queued") return;
        run.status = "running";
        run.events.push({ id: `evt_${randomUUID()}`, type: "run.started", at: Date.now() });
        run.updatedAt = Date.now();
      });
      if (sdkRun) await persistSdkCompanyRun(sdkRun);
    }
    const budgetAbort = new AbortController();
    const onLeaseLost = () => budgetAbort.abort(new Error("Durable task lease lost; stopping before another worker can continue."));
    const onMissionLeaseLost = () => budgetAbort.abort(new Error("Mission lease lost; stopping before another worker can continue."));
    leaseSignal?.addEventListener("abort", onLeaseLost, { once: true });
    missionLeaseLost?.signal.addEventListener("abort", onMissionLeaseLost, { once: true });
    const remainingMs = mission ? durationSeconds! * 1000 : durationSeconds && task.sdkStartedAt ? Math.max(1, durationSeconds * 1000 - (Date.now() - task.sdkStartedAt)) : undefined;
    // Node overflows delays above its signed 32-bit maximum to 1ms.
    // Conservatively bound one worker slice rather than aborting immediately.
    const budgetTimer = remainingMs ? setTimeout(() => budgetAbort.abort(new Error("Execution duration budget exhausted")), Math.min(remainingMs, 2_147_483_647)) : undefined;
    const cancellationPoll = setInterval(() => {
      void isTaskCancellationRequested(task.userId, task.id).then((requested) => {
        if (requested) budgetAbort.abort(new Error("Task cancellation requested"));
      }).catch(() => undefined);
    }, TASK_CANCELLATION_CHECK_MS);
    if (await isTaskCancellationRequested(task.userId, task.id)) budgetAbort.abort(new Error("Task cancellation requested"));
    let result;
    let meetingFollowUpDisposition: "completed" | "blocked" | undefined;
    try {
      const runWithExecutionLock = <T>(work: () => Promise<T>): Promise<T> => parallelMission ? work() : withUserLock(task.userId, budgetAbort.signal, work);
      const executeAgentTurn = async (turnPrompt: typeof prompt) => runWithExecutionLock(async () => {
         if (!task.meetingFollowUp) {
           const skillInstructions = await sdkTaskSkillInstructions(task.sdkSkills);
           const wakeInstructions = missionTimerResumed
             ? "This is a post-wake continuation. The timer has already completed. Execute the saved active-step action now; do not narrate, repeat the pre-wait checkpoint, or call CHUCK_TASK_WAIT."
             : undefined;
           const instructions = [task.sdkInstructions, skillInstructions, wakeInstructions].filter(Boolean).join("\n\n").slice(0, 24000) || undefined;
           return runAgent(task.userId, turnPrompt, agentHistory, task.sdkModel ?? session.model, undefined, budgetAbort.signal, undefined, task.approvedApprovalId, undefined, { toolAllow: missionWorkerToolAllowlist(task.missionAllowedTools, task.sdkTools?.allow), toolDeny: task.sdkTools?.deny, toolRequireApproval: task.sdkTools?.requireApproval, maxToolCalls: mission ? Math.min(task.sdkBudget?.maxToolCalls ?? mission.budget.maxToolCalls, Math.max(1, missionRemainingTools ?? 1)) : task.sdkBudget?.maxToolCalls, maxCost: mission ? Math.min(task.sdkBudget?.maxCost ?? mission.budget.maxCost, Math.max(0.0001, missionRemainingCost ?? 0.0001)) : task.sdkBudget?.maxCost, instructions, runId: task.sdkRunId, parentRunId: task.sdkThreadId, taskId: task.id, missionId: task.missionId, missionStepId: task.missionStepId, missionStepObjective: currentMissionStep?.objective, missionToolHints: task.missionToolHints, missionTimerResumed, missionWakeCheckpoint, missionWakeNextAction, ownerPrivateRun: task.sdkOwnerPrivateRun === true, organizationId: task.sdkOrganizationId, missionRoutingCache: task.attempt > 0 ? undefined : task.missionRoutingCache, enqueueMissionTask });
         }
  
        const followUp = task.meetingFollowUp;
        const execution = await executeScheduledMeetingFollowUp({ userId: task.userId, taskId: task.id, binding: followUp }, {
          getMeeting: getRecallMeeting,
          getProfile: getMeetingRepresentativeProfile,
          getContact: getMeetingContact,
          canSend: canSpend,
          updateState: async (userId, taskId, state) => Boolean(await updateTask(userId, taskId, { meetingFollowUp: { ...followUp, state } })),
          send: async ({ meeting, profile, emailTool, prompt: followUpPrompt }) => {
            const agentResult = await runAgent(
              task.userId,
              followUpPrompt,
              [],
              session.model || config.defaultModel,
              undefined,
              budgetAbort.signal,
              undefined,
              undefined,
              { accountId: `meeting:${meeting.id}`, provider: "telegram", conversationId: meeting.id, scope: "shared" },
              {
                ephemeral: true,
                toolAllow: [emailTool],
                toolRequireApproval: [],
                maxCost: 0.35,
                maxToolCalls: 1,
                meetingComposioAccountAliases: profile.composioAccountAliases,
                instructions: `Send one short, accurate email only to the captured participant address in the supplied contact card. Use only ${emailTool}. Do not access owner history or use any other tool. Do not claim delivery unless the tool succeeds.`,
              },
            );
            if (agentResult.cost) await addUsage(task.userId, agentResult.cost);
            return { toolsUsed: agentResult.toolsUsed, toolsSucceeded: agentResult.toolsSucceeded, toolOutcomes: agentResult.toolOutcomes, cost: agentResult.cost };
          },
        });
        meetingFollowUpDisposition = execution.status;
        return { text: execution.message, toolsUsed: execution.toolsUsed, toolsSucceeded: execution.toolsSucceeded, toolOutcomes: [], cost: execution.cost };
      });
      result = await executeAgentTurn(prompt);
      if (missionWakeNeedsRecovery(missionTimerResumed, result)) {
        const recoveryPrompt = `${prompt}\n\nMANDATORY WAKE RECOVERY: The previous wake turn made no tool call and did not persist progress. This is the only automatic recovery turn. Execute the active step now with a native or provider tool, or persist an explicit wait/block. Do not return prose alone.`;
        const recovery = await executeAgentTurn(recoveryPrompt);
        result = {
          ...recovery,
          toolsUsed: [...result.toolsUsed, ...recovery.toolsUsed],
          toolsSucceeded: [...result.toolsSucceeded, ...recovery.toolsSucceeded],
          toolOutcomes: [...(result.toolOutcomes ?? []), ...(recovery.toolOutcomes ?? [])],
          cost: (result.cost ?? 0) + (recovery.cost ?? 0),
        };
      }
      if (mission && missionNeedsLifecycleCloseoutNudge(result)) {
        const closeoutPrompt = `${prompt}\n\nMANDATORY LIFECYCLE CLOSEOUT: This slice already persisted durable mission progress, but it did not terminate the active step. Inspect the persisted mission state now. If the active step objective and its evidence are genuinely satisfied, call CHUCK_MISSION_STEP_COMPLETE exactly once for that active step. If they are not satisfied, persist the exact next action with CHUCK_MISSION_CHECKPOINT, CHUCK_TASK_WAIT, CHUCK_MISSION_WAIT_EVENT, CHUCK_MISSION_BLOCK, or CHUCK_MISSION_PAUSE. Do not return prose alone, do not repeat a provider action, and do not claim completion without the required trusted evidence.`;
        const closeout = await executeAgentTurn(closeoutPrompt);
        result = {
          ...closeout,
          toolsUsed: [...result.toolsUsed, ...closeout.toolsUsed],
          toolsSucceeded: [...result.toolsSucceeded, ...closeout.toolsSucceeded],
          toolOutcomes: [...(result.toolOutcomes ?? []), ...(closeout.toolOutcomes ?? [])],
          cost: (result.cost ?? 0) + (closeout.cost ?? 0),
        };
      }
    }
    catch (error) {
      const cancelled = (await getTask(task.userId, task.id))?.status === "cancel_requested" || (await getTask(task.userId, task.id))?.status === "cancelled";
      if (cancelled && task.sdkRunId && task.sdkThreadId) {
        const sdkRun = await updateTaskSdkRun(task, (run) => {
          run.status = "cancelled";
          run.events.push({ id: `evt_${randomUUID()}`, type: "run.cancelled", at: Date.now() });
          run.updatedAt = Date.now();
        });
        if (sdkRun) await persistSdkCompanyRun(sdkRun);
      }
      const missionLeaseReason = missionLeaseLost?.signal.reason;
      if (mission && missionLeaseReason instanceof Error && /Mission lease/.test(missionLeaseReason.message)) {
        const missionId = mission.id;
        const stepLabel = currentMissionStep?.title ?? task.missionStepId ?? "the active step";
        const message = `Mission step ${stepLabel} lost its execution lease before the worker could settle the slice. No automatic replay was attempted because provider state is not proven.`;
        const nextAction = "Inspect the saved checkpoint and task receipt if applicable, then repair or resume this same mission explicitly.";
        const blocked = await updateMission(task.userId, missionId, (current) => {
          const currentLease = missionLeaseStepId ? current.executionLeases?.[missionLeaseStepId] : current.lease;
          if (current.status !== "running" || !currentLease || currentLease.token !== missionLeaseToken) return undefined;
          return {
            status: "blocked" as const,
            error: message,
            nextAction,
            waiting: undefined,
            events: [...current.events, { id: `misevt_${randomUUID()}`, type: "blocked" as const, message, at: Date.now(), ...(missionLeaseStepId ? { stepId: missionLeaseStepId } : {}) }],
          };
        }).catch((updateError) => {
          logger.warn({ err: updateError, missionId, taskId: task.id }, "Mission lease-loss block could not be persisted");
          return undefined;
        });
        if (blocked) {
          return { status: "blocked" as const, message: blocked.error ?? message, checkpoint: blocked.checkpoint ?? mission.checkpoint, nextAction: blocked.nextAction ?? nextAction, failureClass: "provider_uncertain" };
        }
      }
      throw error;
    }
    finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      leaseSignal?.removeEventListener("abort", onLeaseLost);
      missionLeaseLost?.signal.removeEventListener("abort", onMissionLeaseLost);
      clearInterval(cancellationPoll);
      if (missionLeaseRenewal) clearInterval(missionLeaseRenewal);
      if (mission?.id && missionLeaseToken) {
        if (missionLeaseStepId) await releaseMissionStepLease(task.userId, mission.id, missionLeaseStepId, missionLeaseToken);
        else await releaseMissionLease(task.userId, mission.id, missionLeaseToken);
      }
      if (quotaReservationId) await releaseExecutionQuota(task.userId, quotaReservationId).catch((error) => logger.warn({ err: error, taskId: task.id }, "Execution quota reservation release failed"));
    }
    if (result.missionRoutingCache && task.missionStepId) await updateTask(task.userId, task.id, { missionRoutingCache: result.missionRoutingCache });
    if (task.approvedApprovalId) await updateTask(task.userId, task.id, { approvedApprovalId: undefined });
    if (result.taskWait) {
      let postWakeNextAction = result.taskWait.nextAction;
      if (mission) {
        const currentMission = await getMission(task.userId, mission.id);
        const activeStepIds = new Set(currentMission?.activeStepIds?.length ? currentMission.activeStepIds : currentMission?.currentStepId ? [currentMission.currentStepId] : []);
        const boundStep = task.missionStepId ? currentMission?.steps.find((step) => step.id === task.missionStepId) : undefined;
        if (task.missionStepId && (!activeStepIds.has(task.missionStepId) || boundStep?.status !== "running")) {
          if (boundStep?.status === "completed" && currentMission && currentMission.status === "running") {
            await reconcileMissionExecution(task.userId, mission.id, enqueueMissionTask, task.id);
            return { status: "completed" as const, message: `Timer request was discarded because task ${task.id} no longer owns an active mission step.`, checkpoint: currentMission.checkpoint, nextAction: currentMission.nextAction };
          }
          const blocked = await updateMission(task.userId, mission.id, {
            status: "blocked",
            error: "A timer wait was requested by a task that does not own an active running mission step.",
            nextAction: "Inspect the mission task and active step, then resume or replan. The timer was not persisted.",
          });
          return { status: "blocked" as const, message: blocked?.error ?? "Timer wait ownership check failed.", checkpoint: blocked?.checkpoint ?? currentMission?.checkpoint, nextAction: blocked?.nextAction };
        }
        const accounted = currentMission && ["running", "waiting"].includes(currentMission.status)
          ? await recordMissionSlice(task.userId, mission.id, { checkpoint: currentMission.checkpoint ?? result.taskWait.checkpoint, nextAction: postWakeNextAction, toolCalls: missionToolCallCount(result), cost: result.cost })
          : currentMission;
        if (!accounted || accounted.status === "blocked") return { status: "blocked" as const, message: accounted?.error ?? "Autonomous mission could not record its progress before waiting.", checkpoint: accounted?.checkpoint, nextAction: accounted?.nextAction };
        if (accounted.status !== "running") {
          return {
            status: accounted.status === "completed" ? "completed" as const : accounted.status === "cancelled" ? "cancelled" as const : "blocked" as const,
            message: accounted.result ?? accounted.error ?? `Mission is ${accounted.status}; the timer wait was not scheduled.`,
            result: accounted.result,
            checkpoint: accounted.checkpoint,
            nextAction: accounted.nextAction,
          };
        }
        const resumeStep = missionTimerResumeStep(accounted, task.missionStepId);
        if (!resumeStep) {
          const blocked = await updateMission(task.userId, mission.id, (latest) => latest.status !== "running" ? undefined : {
            status: "blocked",
            error: "Timer wait was requested after the mission had no active executable step.",
            nextAction: "Repair or replan the mission so the timer resumes an active step.",
            events: [...latest.events, { id: `misevt_${randomUUID()}`, type: "blocked", message: "Timer wait rejected because no active mission step could own its continuation.", at: Date.now() }],
          });
          return { status: "blocked" as const, message: blocked?.error ?? "Mission has no active step for the timer continuation.", checkpoint: blocked?.checkpoint, nextAction: blocked?.nextAction };
        }
        postWakeNextAction = missionPostWakeNextAction(resumeStep);
        const waited = await waitMission(task.userId, mission.id, { kind: "timer", runAt: result.taskWait.runAt, stepId: resumeStep.id }, result.taskWait.checkpoint, postWakeNextAction);
        if (!waited) {
          const latest = await getMission(task.userId, mission.id);
          if (latest?.status === "waiting" && latest.waiting?.kind === "timer" && latest.waiting.runAt === result.taskWait.runAt && latest.waiting.stepId === resumeStep.id) {
            postWakeNextAction = latest.nextAction ?? postWakeNextAction;
          } else {
            throw new Error("Mission timer continuation was not persisted; retry from the latest mission state.");
          }
        }
        if (waited?.status !== "waiting" && waited !== undefined) {
          return { status: "blocked" as const, message: `Mission timer transition returned ${waited.status}; no wait was reported to the task runner.`, checkpoint: waited.checkpoint, nextAction: waited.nextAction };
        }
      }
      if (task.sdkRunId && task.sdkThreadId) {
        const sdkRun = await updateTaskSdkRun(task, (run) => {
          run.status = "queued";
          run.output = undefined;
          run.error = undefined;
          run.events.push({ id: `evt_${randomUUID()}`, type: "run.waiting_for_task", at: Date.now(), text: new Date(result.taskWait!.runAt).toISOString() });
          run.updatedAt = Date.now();
        });
        if (sdkRun) await persistSdkCompanyRun(sdkRun);
      }
      return { status: "queued" as const, waiting: true, message: result.text, checkpoint: result.taskWait.checkpoint, nextAction: postWakeNextAction, runAt: result.taskWait.runAt };
    }
    if (result.missionWait && mission) {
      const currentMission = await getMission(task.userId, mission.id);
      const activeStepIds = new Set(currentMission?.activeStepIds?.length ? currentMission.activeStepIds : currentMission?.currentStepId ? [currentMission.currentStepId] : []);
      const requestedStepId = result.missionWait.stepId;
      const requestedStep = requestedStepId ? currentMission?.steps.find((step) => step.id === requestedStepId) : undefined;
      const eventStepIsOwned = Boolean(task.missionStepId && requestedStepId === task.missionStepId && activeStepIds.has(task.missionStepId) && requestedStep?.status === "running");
      if (!eventStepIsOwned) {
        const boundStep = task.missionStepId ? currentMission?.steps.find((step) => step.id === task.missionStepId) : undefined;
        if (boundStep?.status === "completed" && currentMission?.status === "running") {
          await reconcileMissionExecution(task.userId, mission.id, enqueueMissionTask, task.id);
          return { status: "completed" as const, message: `Provider wait was discarded because task ${task.id} no longer owns an active step.`, checkpoint: currentMission.checkpoint, nextAction: currentMission.nextAction };
        }
        const blocked = await updateMission(task.userId, mission.id, {
          status: "blocked",
          error: "A provider-event wait was requested by a task that does not own that active mission step.",
          nextAction: "Inspect the mission task and active step, then resume or replan. The event wait was not persisted.",
        });
        return { status: "blocked" as const, message: blocked?.error ?? "Provider-event wait ownership check failed.", checkpoint: blocked?.checkpoint ?? currentMission?.checkpoint, nextAction: blocked?.nextAction };
      }
      const accounted = currentMission && ["running", "waiting"].includes(currentMission.status)
        ? await recordMissionSlice(task.userId, mission.id, { checkpoint: currentMission.checkpoint ?? result.missionWait.checkpoint, nextAction: result.missionWait.nextAction, toolCalls: missionToolCallCount(result), cost: result.cost })
        : currentMission;
      if (!accounted || accounted.status === "blocked") return { status: "blocked" as const, message: accounted?.error ?? "Autonomous mission could not record its progress before waiting.", checkpoint: accounted?.checkpoint, nextAction: accounted?.nextAction };
      const timeoutSeconds = result.missionWait.timeoutSeconds;
      if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 30 * 24 * 60 * 60)) {
        const blocked = await updateMission(task.userId, mission.id, (current) => current.status !== "running"
          || !(current.activeStepIds?.length ? current.activeStepIds : current.currentStepId ? [current.currentStepId] : []).includes(task.missionStepId ?? "")
          || current.steps.find((step) => step.id === task.missionStepId)?.status !== "running"
          ? undefined
          : {
            status: "blocked" as const,
            error: "The provider-event wait had an invalid timeout and was not scheduled.",
            nextAction: "Retry with a whole-number timeout between 60 seconds and 30 days, or wait without an expiry.",
          });
        return { status: "blocked" as const, message: blocked?.error ?? "Invalid provider-event timeout.", checkpoint: blocked?.checkpoint ?? currentMission?.checkpoint, nextAction: blocked?.nextAction };
      }
      let expiresAt = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
      const requestedWait = { kind: "provider_event" as const, provider: result.missionWait.provider, providerEventId: result.missionWait.providerEventId, stepId: result.missionWait.stepId, expiresAt };
      const persistedWait = await waitMission(task.userId, mission.id, requestedWait, result.missionWait.checkpoint, result.missionWait.nextAction);
      const latestMission = persistedWait ?? await getMission(task.userId, mission.id);
      const waitIsPersisted = latestMission?.status === "waiting"
        && latestMission.waiting?.kind === "provider_event"
        && latestMission.waiting.provider === requestedWait.provider
        && latestMission.waiting.providerEventId === requestedWait.providerEventId
        && latestMission.waiting.stepId === requestedWait.stepId;
      if (!waitIsPersisted) {
        const currentStep = latestMission?.steps.find((step) => step.id === task.missionStepId);
        if (latestMission?.status === "running" && currentStep?.status === "completed") {
          await reconcileMissionExecution(task.userId, mission.id, enqueueMissionTask, task.id);
          return { status: "completed" as const, message: "Provider wait was not persisted because its mission step had already completed.", checkpoint: latestMission.checkpoint, nextAction: latestMission.nextAction };
        }
        if (latestMission?.status === "running" && currentStep?.status === "running") {
          const blocked = await updateMission(task.userId, mission.id, (current) => current.status !== "running"
            || current.steps.find((step) => step.id === task.missionStepId)?.status !== "running"
            ? undefined
            : {
              status: "blocked" as const,
              error: "The provider-event wait could not be confirmed in persisted mission state.",
              nextAction: "Inspect the provider state and mission checkpoint, then resume or replan. Do not repeat a dispatched provider action without read-back.",
              events: [...current.events, { id: `misevt_${randomUUID()}`, type: "blocked" as const, message: "Provider-event wait persistence could not be confirmed.", at: Date.now(), stepId: task.missionStepId }],
            });
          return { status: "blocked" as const, message: blocked?.error ?? "Provider-event wait persistence could not be confirmed.", checkpoint: blocked?.checkpoint ?? latestMission.checkpoint, nextAction: blocked?.nextAction ?? "Inspect the provider state and mission checkpoint before resuming." };
        }
        return { status: "blocked" as const, message: "Provider-event wait was not persisted; mission state changed before the wait could be recorded.", checkpoint: latestMission?.checkpoint ?? currentMission?.checkpoint, nextAction: latestMission?.nextAction ?? "Inspect the current mission state before resuming." };
      }
      // An idempotent replay may have encountered the already-persisted wait.
      // Use its deadline, not a newly computed one, for the workflow wake.
      expiresAt = latestMission?.waiting?.kind === "provider_event" ? latestMission.waiting.expiresAt : expiresAt;
      // An event with no expiry has no safe polling deadline. Leave
      // the task blocked until the signed provider callback wakes
      // the exact mission branch; an expiry gets one durable wake
      // that can convert a missed event into an honest blocker.
      if (!expiresAt) return { status: "blocked" as const, message: result.text, checkpoint: result.missionWait.checkpoint, nextAction: result.missionWait.nextAction ?? "Wait for the exact provider event; the mission will resume automatically when it arrives." };
      return { status: "queued" as const, waiting: true, message: result.text, checkpoint: result.missionWait.checkpoint, nextAction: result.missionWait.nextAction, runAt: expiresAt };
    }
    if (mission) {
                  return settleMissionSlice({ task, mission, currentMissionStep, result, before: missionSliceBefore, enqueue: enqueueMissionTask });
    }
    if (task.sdkRunId && task.sdkThreadId) {
      if (result.cost) await addUsage(task.userId, result.cost);
      const runInput = await getSdkRun(task.userId, task.sdkThreadId, task.sdkRunId);
      const settledAt = Date.now();
      const sdkRun = await updateTaskSdkRun(task, (run) => {
        run.status = "completed";
        run.output = result.text;
        run.artifacts = sdkRunArtifacts(result.generatedFiles);
        run.cost = result.cost;
        run.events.push({ id: `evt_${randomUUID()}`, type: "run.completed", at: settledAt });
        run.updatedAt = settledAt;
      }, runInput ? [
        { role: "user", content: `${runInput.input || "Attached file(s)"}${runInput.attachments?.length ? `\n[Attachments: ${runInput.attachments.map((file) => file.name).join(", ")}]` : ""}`, createdAt: runInput.createdAt },
        { role: "assistant", content: result.text, createdAt: settledAt },
      ] : undefined);
      if (sdkRun) await persistSdkCompanyRun(sdkRun);
      await completeTask(task.userId, task.id, result.text);
    }
    if (task.meetingFollowUp) {
      const chatId = await getTelegramChatId(task.userId);
      if (chatId && result.text.trim()) await context.sendMessage(chatId, `📌 <b>Meeting follow-up</b>\n\n${result.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`, { parse_mode: "HTML" });
      if (meetingFollowUpDisposition === "completed") return { status: "completed" as const, message: "Scheduled meeting follow-up email sent", result: result.text };
      return { status: "blocked" as const, message: result.text, result: result.text, nextAction: "Review the meeting follow-up task. Retry only when email delivery is known not to have occurred." };
    }
    const latest = await getTask(task.userId, task.id);
    const chatId = await getTelegramChatId(task.userId);
    if (chatId && result.text.trim()) await context.sendMessage(chatId, `📌 <b>Task update</b>\n\n${result.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`, { parse_mode: "HTML" });
    if (latest?.status === "completed") return { status: "completed" as const, message: "Task completed by the agent", result: latest.result, checkpoint: latest.checkpoint };
    return { status: "blocked" as const, message: "Task ran and is awaiting review or a next instruction", checkpoint: latest?.checkpoint, nextAction: latest?.nextAction ?? "Review the task update and continue when ready." };
  } catch (error) {
    if (error instanceof ApprovalRequiredError) {
      if (task.sdkRunId && task.sdkThreadId) {
        const sdkRun = await updateTaskSdkRun(task, (run) => {
          run.status = "requires_approval";
          run.approvalId = error.approvalId;
          run.events.push({ id: `evt_${randomUUID()}`, type: "run.approval_required", at: Date.now() });
          run.updatedAt = Date.now();
        });
        if (sdkRun) await persistSdkCompanyRun(sdkRun);
      }
      if (mission) {
        const approval = await getApproval(task.userId, error.approvalId);
        const expiresAt = approval?.expiresAt;
        // The model may have persisted a checkpoint immediately before the
        // approval boundary. The mission object captured before the turn is
        // stale at this point; using it here can roll the checkpoint back and
        // make the resumed worker repeat the same wait forever. Read the
        // latest durable mission state before parking the approval.
        const latestMission = await getMission(task.userId, mission.id);
        const approvalCheckpoint = latestMission?.checkpoint ?? mission.checkpoint;
        const approvalStepId = latestMission?.currentStepId ?? mission.currentStepId;
        const approvalNextAction = `Approve or deny ${error.toolSlug} (${error.approvalId}) before continuing.`;
        await waitMission(task.userId, mission.id, { kind: "approval", key: error.approvalId, stepId: approvalStepId, expiresAt }, approvalCheckpoint, approvalNextAction);
        return { status: "queued" as const, waiting: true, message: `Mission is waiting for approval of ${error.toolSlug}.`, checkpoint: approvalCheckpoint, nextAction: approvalNextAction, runAt: expiresAt ?? Date.now() + 24 * 60 * 60 * 1000 };
      }
      return { status: "blocked" as const, message: `Approval required for ${error.toolSlug}`, nextAction: "Approve or deny the pending action, then retry the task." };
    }
    if (task.sdkRunId && task.sdkThreadId) {
      const message = error instanceof Error ? error.message : "Agent failed";
      const sdkRun = await updateTaskSdkRun(task, (run) => {
        run.status = "failed";
        run.error = { code: "agent_error", message };
        run.events.push({ id: `evt_${randomUUID()}`, type: "run.failed", at: Date.now(), text: message });
        run.updatedAt = Date.now();
      });
      if (sdkRun) await persistSdkCompanyRun(sdkRun);
    }
    throw error;
  }
}
