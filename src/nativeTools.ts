import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { enqueueTaskWorkflow, workflowFailureUrl } from "./triggerWorkflow.js";
import { resolveWorkflowEndpoint } from "./workflowUrls.js";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  addJob, addReminder, clearScratchpad, getJob, getReminder, getSession, getRecallMeeting, listJobs, listReminders,
  getMeetingRepresentativeProfile, updateMeetingRepresentativeProfile,
  upsertMeetingContact, listMeetingContacts, deleteMeetingContact, getMeetingContact, updateMeetingContact,
  readScratchpad, updateJob, updateReminder, writeScratchpad,
  forgetMemory, searchMemories, updateMemory, upsertMemory,
  blockTask, cancelTask, checkpointTask, completeTask, createTask, getTask, listTasks, retryTask, scheduleTask, setTaskWorkflowRunId, getApproval, claimApproval, setApprovalStatus, updateTask, getHandoffRecord,
  blockMission, cancelMission, cancelMissionTasks, checkpointMission, completeMission, completeMissionStep, createMission, getMission, listMissions, missionProof, pauseMission, replanMission, resumeMission, startMission, updateMission, waitMission, recordMissionEvidence, verifyMission, repairMission, missionBudgetPreflight,
  createAttentionRecord, getAttentionRecord, listAttentionRecords, updateAttentionRecord,
  type AttentionEntityKind, type DeliveryPreferenceRecord,
  type TaskStatus, type MissionStatus,
  type JobRecord, type ReminderRecord, type ScheduledWorkerBinding, type ReminderDeliveryTarget,
  listPhoneCalls, saveImageAsset, searchImageAssets, getImageAsset, forgetImageAsset,
  listVideoJobs, listHandoffRecords, saveHandoffRecord, listCalendarMeetingPreparations,
  searchRecallMeetingTranscripts, deleteRecallMeetingTranscript, saveBrowserPlaybook, findBrowserPlaybook, listBrowserPlaybooks, removeBrowserPlaybook, addBrowserAudit, listBrowserAudit, saveBrowserHandoff, getBrowserHandoff, listBrowserHandoffs, updateBrowserHandoff,
} from "./store.js";
import { daytonaEngine } from "./lib/daytona/index.js";
import { startTwilioCallForUser } from "./calls/twilio.js";
import { startBlandCallForUser } from "./calls/bland.js";
import { executeDelegation, requestDelegationCancellation } from "./subagents/executor.js";
import { WORKER_CAPABILITIES, isComposioToolAllowedForWorker, normalizeDelegationToolScopes, planDelegationObjective } from "./subagents/capabilities.js";
import { enqueueSubagentToolContinuation, resolveSubagentToolRequest } from "./subagents/workflow.js";
import { listSkillFiles, readSkillFile, searchSkills } from "./skills/catalog.js";
import { abortable, throwIfAborted } from "./cancellation.js";
import { beginVaultSetup, browserSessionHealth, listVault, logoutVault, normaliseVaultOrigin, normaliseVaultService, recordVaultSession, vaultStatus } from "./vault/vault.js";
import { loginWithVault } from "./vault/broker.js";
import { classifyBrowserIntent, createBrowserOperationPlan, normalizeBrowserAlias, normalizeBrowserOrigin, normalizePlaybook, verifyBrowserResult, type BrowserHandoffReason, type BrowserPlaybookRecord } from "./vault/browserOps.js";
import { cancelShopping, listSavedShoppingSites, listShopping, pauseShopping, removeSavedShoppingSite, resumeShopping, saveShoppingSitePreference, selectShoppingRetailer, startShopping, updateShopping } from "./shopping/shopping.js";
import { cancelAutomaticCalendarMeetingJoins, getRecallMeetingForUser, joinRecallMeeting, joinPreparedCalendarMeeting, leaveRecallMeeting, listRecallMeetingsForUser, lookupRecallMeetingContext, ownerExplicitlyRequestedTranscriptRetention, prepareRecallMeetingMission } from "./meetings/service.js";
import { hasMeetingMissionInput } from "./meetings/mission.js";
import { isMeetingRepresentativeEmailTool } from "./meetings/representative.js";
import type { TaskWaitRequest } from "./types.js";
import { createTaskWaitRequest } from "./taskWait.js";
import type { AutonomyLinks, AutonomyMode } from "./autonomy/types.js";
import { contextPrompt, selectContext, upsertContextNode } from "./contextGraph.js";
import { createDepartmentHandoff } from "./departments.js";
import { listOutcomePackages, planOutcome } from "./outcomes/catalog.js";
import { scheduleMissionSteps } from "./missionScheduler.js";

const MAX_TEXT = 1000;
const MAX_DAYTONA_COMMAND = 64000;

export interface NativeToolRuntime {
  currentImages?: Array<{ data: Uint8Array; mediaType: string; filename?: string }>;
  generatedImages?: Array<{ data: Uint8Array; mediaType: string; filename?: string }>;
  model?: string;
  historySummary?: string;
  onStatus?: (statusText: string) => Promise<void> | void;
  approvedApprovalId?: string;
  signal?: AbortSignal;
  /** Worker-owned resources can register bounded cleanup on cancellation. */
  registerCancellationCleanup?: (cleanup: () => Promise<void>) => void;
  deliveryTarget?: import("./channels/contracts.js").ReplyTarget;
  /** Present only when a specialist is executing its own native tool call. */
  worker?: Exclude<import("./memory/types.js").CapabilityWorkerName, "chusky">;
  workerBinding?: Omit<ScheduledWorkerBinding, "worker" | "objective">;
  /** Present only for an authenticated Recall meeting run. */
  meetingId?: string;
  /** Private relationship preparation must never run from a shared channel. */
  sharedConversation?: boolean;
  /** Current owner request, used for explicit-opt-in checks at native boundaries. */
  userRequest?: string;
  /** The durable task currently executing; absent for interactive turns. */
  taskId?: string;
  /** The autonomous mission currently executing this bounded slice. */
  missionId?: string;
  /** Set by the internal task-wait tool; the workflow settles the run after the agent turn ends. */
  requestTaskWait?: (request: TaskWaitRequest) => void;
  /** Set by the mission event-wait tool; the workflow parks the durable slice. */
  requestMissionWait?: (request: MissionWaitRequest) => void;
}

export interface MissionWaitRequest {
  provider: string;
  providerEventId: string;
  stepId?: string;
  checkpoint?: string;
  nextAction?: string;
  timeoutSeconds?: number;
}

type PhoneCallLauncherForTests = (userId: number, input: Record<string, unknown>) => Promise<unknown>;
let phoneCallLauncherForTests: PhoneCallLauncherForTests | undefined;

/** Test seam for authenticated call routes; production uses the configured provider below. */
export function setPhoneCallLauncherForTests(launcher?: PhoneCallLauncherForTests): void {
  phoneCallLauncherForTests = launcher;
}

function text(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > MAX_TEXT) throw new Error(`Text must be 1-${MAX_TEXT} characters`);
  return result;
}

function daytonaCommand(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > MAX_DAYTONA_COMMAND) throw new Error(`Command must be 1-${MAX_DAYTONA_COMMAND} characters`);
  return result;
}

function fileContent(value: unknown): string {
  const result = String(value ?? "");
  const max = 48000;
  if (result.length > max) throw new Error(`File content must be at most ${max} characters`);
  return result;
}

function taskStatuses(value: unknown): TaskStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("statuses must be an array");
  const allowed: TaskStatus[] = ["queued", "running", "blocked", "completed", "failed", "cancel_requested", "cancelled"];
  const statuses = value.map((item) => String(item));
  if (statuses.length > allowed.length || statuses.some((status) => !allowed.includes(status as TaskStatus))) throw new Error("Invalid task status filter");
  return [...new Set(statuses)] as TaskStatus[];
}

function missionStatuses(value: unknown): MissionStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("statuses must be an array");
  const allowed: MissionStatus[] = ["queued", "running", "waiting", "paused", "blocked", "completed", "failed", "cancelled"];
  const statuses = value.map((item) => String(item));
  if (statuses.length > allowed.length || statuses.some((status) => !allowed.includes(status as MissionStatus))) throw new Error("Invalid mission status filter");
  return [...new Set(statuses)] as MissionStatus[];
}

function stringList(value: unknown, label: string, maxItems = 12): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!items.length || items.length > maxItems || items.some((item) => item.length > 200)) {
    throw new Error(`${label} must contain 1-${maxItems} non-empty items of at most 200 characters`);
  }
  return items;
}

function assertSafeBrowserRecipe(value: unknown, path = "recipe"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeBrowserRecipe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(password|username|credential|cookie|secret|token|accessToken|refreshToken|inputValue|textValue)$/i.test(key)) throw new Error(`${path} contains a forbidden secret field`);
    assertSafeBrowserRecipe(child, `${path}.${key}`);
  }
}

function browserHandoffReason(value: unknown): BrowserHandoffReason {
  const reason = String(value ?? "site_challenge");
  if (!["captcha", "two_factor", "age_verification", "site_challenge", "login", "user_requested"].includes(reason)) throw new Error("reason is not a supported browser handoff reason");
  return reason as BrowserHandoffReason;
}

async function createBrowserHandoffRecord(userId: number, input: { reason?: unknown; service?: unknown; origin?: unknown; shoppingPlanId?: unknown }) {
  const reason = browserHandoffReason(input.reason);
  const service = input.service ? normaliseVaultService(text(input.service)) : undefined;
  const origin = input.origin ? normaliseVaultOrigin(text(input.origin)) : undefined;
  const handoff = await daytonaEngine.browserHandoff(userId, reason.replaceAll("_", " "));
  const record = await saveBrowserHandoff(userId, {
    id: `bh_${randomUUID()}`,
    userId,
    workspaceId: handoff.sandboxId,
    ...(service ? { service } : {}),
    ...(origin ? { origin } : {}),
    reason,
    status: "waiting",
    createdAt: Date.now(),
    expiresAt: handoff.expiresAt,
  });
  await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_requested", ...(service ? { service } : {}), ...(origin ? { origin } : {}), status: "waiting", summary: `Private browser handoff requested for ${reason.replaceAll("_", " ")}`, createdAt: Date.now() });
  const shoppingPlan = input.shoppingPlanId ? await pauseShopping(userId, { id: text(input.shoppingPlanId), reason }) : undefined;
  return { ...handoff, handoffId: record.id, status: record.status, reason, ...(service ? { service } : {}), ...(origin ? { origin } : {}), ...(shoppingPlan ? { shoppingPlan: { id: shoppingPlan.id, status: shoppingPlan.status, pausedReason: shoppingPlan.pausedReason } } : {}) };
}

async function runDelegationWithDurableContinuation(
  userId: number,
  contract: Parameters<typeof executeDelegation>[1],
  runtime: NativeToolRuntime,
): Promise<unknown> {
  const durableTarget = durableReminderTarget(runtime.deliveryTarget);
  const durableContext = durableTarget && !contract.context?.deliveryTarget
    ? { ...(contract.context ?? {}), deliveryTarget: durableTarget }
    : contract.context;
  const result = await executeDelegation(userId, { ...contract, context: durableContext }, runtime);
  if (result.status !== "requires_tool_request" || !result.handoffRecord) return result;
  const continuation = await enqueueSubagentToolContinuation(userId, result.handoffRecord.id);
  return { ...result, durableContinuation: { queued: true, ...continuation } };
}

async function daytonaCall<T>(runtime: NativeToolRuntime, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(runtime.signal);
  const result = await abortable(operation(), runtime.signal);
  throwIfAborted(runtime.signal);
  return result;
}

/**
 * A mixed supervisor request must never leak a routing error to the user. Each
 * stage remains a normal durable least-privilege delegation; later stages see
 * only a bounded prior handoff, and are not started after a paused/failed one.
 */
async function runPlannedDelegation(
  userId: number,
  contract: Parameters<typeof executeDelegation>[1],
  runtime: NativeToolRuntime,
): Promise<unknown> {
  contract = { ...contract, ...normalizeDelegationToolScopes(contract) };
  if (runtime.worker) return runDelegationWithDurableContinuation(userId, contract, runtime);
  const plan = planDelegationObjective(contract.objective, contract.allowedTools ?? []);
  if (plan.length < 2) return runDelegationWithDurableContinuation(userId, contract, runtime);

  await runtime.onStatus?.(`🧭 Coordinating ${plan.map((step) => WORKER_CAPABILITIES[step.worker].displayName).join(" → ")}`);
  const stages: Array<{ worker: string; handoffId?: string; taskId?: string; status: string; output: string }> = [];
  let priorHandoff = "";
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index]!;
    const capability = WORKER_CAPABILITIES[step.worker];
    const sourceContext = { ...(contract.context ?? {}) } as Record<string, unknown>;
    const requestedTool = sourceContext.toolCall as { name?: unknown } | undefined;
    if (requestedTool?.name && !capability.allowedTools.includes(String(requestedTool.name))) delete sourceContext.toolCall;
    const result = await runDelegationWithDurableContinuation(userId, {
      ...contract,
      worker: step.worker,
      objective: step.objective,
      expectedOutput: `${capability.displayName} handoff for the supervisor and any dependent specialist.`,
      allowedTools: contract.allowedTools?.filter((tool) => capability.allowedTools.includes(tool)),
      allowedComposioTools: contract.allowedComposioTools?.filter((tool) => isComposioToolAllowedForWorker(step.worker, tool)),
      context: {
        ...sourceContext,
        supervisorObjective: contract.objective,
        stage: { index: index + 1, total: plan.length, worker: step.worker, dependsOn: step.dependsOn },
        ...(priorHandoff ? { priorSpecialistHandoff: priorHandoff } : {}),
      },
    }, runtime) as { status?: string; output?: string; handoffRecord?: { id?: string }; taskId?: string };
    const status = String(result.status ?? "failed");
    const output = String(result.output ?? "");
    stages.push({ worker: step.worker, status, output: output.slice(0, 4000), handoffId: result.handoffRecord?.id, taskId: result.taskId });
    priorHandoff = output.slice(0, 6000);
    if (status !== "success" && status !== "fallback_executed") {
      return {
        orchestration: "multi_specialist", status, originalObjective: contract.objective, completedStages: stages,
        pendingStages: plan.slice(index + 1).map((pending) => pending.worker),
        note: "The remaining specialists were not started; Chusky will continue only after this durable stage is resolved.",
      };
    }
  }
  return { orchestration: "multi_specialist", status: "success", originalObjective: contract.objective, completedStages: stages };
}

async function reviewSubagentAction(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): Promise<unknown> {
  const approvalId = text(args.approvalId);
  const decision = String(args.decision ?? "").toLowerCase();
  if (decision !== "approve" && decision !== "deny") throw new Error("decision must be approve or deny");
  const approval = await getApproval(userId, approvalId);
  if (!approval?.handoffId || approval.status !== "pending" || approval.expiresAt <= Date.now()) throw new Error("Subagent proposal is missing, expired, or already reviewed");
  const handoff = await getHandoffRecord(userId, approval.handoffId);
  if (!handoff?.taskId || !handoff.delegation) throw new Error("Subagent proposal is no longer attached to a durable handoff");
  if (decision === "deny") {
    await setApprovalStatus(userId, approvalId, "denied");
    await updateTask(userId, handoff.taskId, { status: "blocked", error: "Chusky supervisor denied the proposed action.", nextAction: "Revise the plan or request a different action." });
    await saveHandoffRecord(userId, { ...handoff, status: "failed" });
    return { reviewed: true, decision, approvalId, taskId: handoff.taskId };
  }
  if (!(await claimApproval(userId, approvalId))) throw new Error("Subagent proposal could not be claimed for review");
  const result = await executeDelegation(userId, {
    worker: handoff.to as any,
    objective: handoff.objective,
    context: { ...handoff.context, supervisorReview: true },
    expectedOutput: handoff.expectedOutput,
    model: handoff.delegation.model,
    allowedTools: handoff.delegation.allowedTools,
    allowedComposioTools: handoff.delegation.allowedComposioTools,
    approvalPolicy: handoff.delegation.approvalPolicy,
    timeoutSeconds: handoff.delegation.timeoutSeconds,
    maxToolCalls: handoff.delegation.maxToolCalls,
    duration: handoff.delegation.duration,
    budgetSeconds: handoff.delegation.budgetSeconds,
  }, { approvedApprovalId: approvalId, resume: { handoffId: handoff.id, taskId: handoff.taskId, resumeCount: (handoff.resumeCount ?? 0) + 1 }, model: runtime.model });
  return { reviewed: true, decision, approvalId, result };
}

function attentionKind(value: unknown): AttentionEntityKind {
  const allowed: AttentionEntityKind[] = ["observation", "open_loop", "attention_candidate", "standing_order", "delivery_preference", "relationship", "project_state"];
  const kind = String(value ?? "");
  if (!allowed.includes(kind as AttentionEntityKind)) throw new Error("Unsupported attention entity");
  return kind as AttentionEntityKind;
}

function attentionInput(args: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set(["action", "kind", "id", "query", "limit"]);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !excluded.has(key)));
}

async function attentionTool(userId: number, args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "");
  if (!["create", "list", "update"].includes(action)) throw new Error("Attention action must be create, list, or update");
  const kind = attentionKind(args.kind);
  if (action === "list") return listAttentionRecords(userId, kind, { query: args.query ? text(args.query) : undefined, status: args.status ? String(args.status).trim().slice(0, 100) : undefined, limit: args.limit === undefined ? undefined : Number(args.limit) });
  if (action === "update") {
    const id = text(args.id);
    const updated = await updateAttentionRecord(userId, kind, id, attentionInput(args));
    if (!updated) throw new Error("Attention record not found or not owned by you");
    return updated;
  }
  const input = attentionInput(args);
  const requiredByKind: Partial<Record<AttentionEntityKind, string[]>> = {
    observation: ["source", "eventType", "summary"], open_loop: ["title", "nextAction"], attention_candidate: ["candidateType", "reason"],
    standing_order: ["name", "instruction", "authority"], delivery_preference: ["provider"], relationship: ["personKey"], project_state: ["projectKey", "name", "summary"],
  };
  for (const field of requiredByKind[kind] ?? []) if (!(field in input) || input[field] === undefined || input[field] === null || input[field] === "") throw new Error(`${field} is required for ${kind}`);
  return createAttentionRecord(userId, kind, input);
}

export function workflowUrl(configured: string, label: string, path: string): string {
  return resolveWorkflowEndpoint(configured, config.webhookUrl, path, label);
}

export function validateCronExpression(value: string): string {
  const cron = value.trim();
  const timezoneMatch = cron.match(/^CRON_TZ=([A-Za-z0-9_./+-]+)\s+/);
  if (timezoneMatch) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezoneMatch[1] }).format(); }
    catch { throw new Error(`cron uses an unknown timezone: ${timezoneMatch[1]}`); }
  }
  const withoutTimezone = timezoneMatch ? cron.slice(timezoneMatch[0].length) : cron;
  const fields = withoutTimezone.split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !field || !/^[0-9*/?,LW#-]+$/.test(field))) {
    throw new Error("cron must be a valid 5-field CRON expression (optionally prefixed with CRON_TZ=<IANA timezone>)");
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  fields.forEach((field, index) => {
    for (const token of field.split(",")) {
      const [base, step] = token.split("/");
      if (token.split("/").length > 2 || base.split("-").length > 2) throw new Error(`cron field ${index + 1} contains an invalid range or step`);
      if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > 60)) throw new Error(`cron field ${index + 1} contains an invalid step`);
      const parts = base.split("-");
      for (const part of parts) {
        if (/^\d+$/.test(part) && (Number(part) < ranges[index][0] || Number(part) > ranges[index][1])) throw new Error(`cron field ${index + 1} contains an out-of-range value`);
      }
    }
  });
  return cron;
}

function requireQStash(): string {
  if (!config.qstashToken) throw new Error("QStash is not configured. Set QSTASH_TOKEN.");
  return config.qstashToken;
}

const ATTENTION_PULSE_JOB_ID = (userId: number) => `pulse_${userId}`;
const ATTENTION_PULSE_SCHEDULE_ID = (userId: number) => `chuck-attention-pulse-${userId}`;
const ATTENTION_PULSE_TOOLS = [
  "CHUCK_TASK_LIST",
  "CHUCK_TASK_GET",
  "CHUCK_TASK_CHECKPOINT",
  "CHUCK_TASK_BLOCK",
  "CHUCK_TASK_COMPLETE",
  "CHUCK_SET_REMINDER",
  "CHUCK_LIST_REMINDERS",
  "CHUCK_CANCEL_REMINDER",
  "CHUCK_ATTENTION_STATE",
  "CHUCK_LIST_JOBS",
  "CHUCK_HANDOFF_SUBAGENT",
  "CHUCK_REQUEST_ADDITIONAL_TOOLS",
];
const ATTENTION_PULSE_BINDING: ScheduledWorkerBinding = {
  worker: "elena",
  objective: "Review the owner's attention state and act within standing-order authority.",
  expectedOutput: "A concise owner-facing attention digest, or NO_ACTION when nothing needs delivery.",
  model: config.defaultModel,
  // Pulse runs are deliberately narrower than ordinary Elena work. They can
  // inspect and update attention/task/reminder state, but cannot directly use
  // connected-app actions without an explicit capability expansion.
  allowedTools: ATTENTION_PULSE_TOOLS,
  allowedComposioTools: [],
  approvalPolicy: "require_chusky_approval",
  timeoutSeconds: 90,
  maxToolCalls: 30,
  duration: "30m",
  budgetSeconds: 1800,
};

async function ensureAttentionPulseDeliveryPreference(userId: number, runtime: NativeToolRuntime): Promise<void> {
  const conversationId = runtime.deliveryTarget?.provider === "telegram"
    ? runtime.deliveryTarget.conversationId
    : String(userId);
  const preferences = await listAttentionRecords(userId, "delivery_preference", { limit: 50 }) as DeliveryPreferenceRecord[];
  const existing = preferences.find((item) => item.provider === "telegram" && (!item.conversationId || item.conversationId === conversationId));
  if (existing) return;
  await createAttentionRecord(userId, "delivery_preference", {
    provider: "telegram",
    conversationId,
    enabled: true,
    mode: "immediate",
  });
}

export async function configureAttentionPulse(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<unknown> {
  const action = String(args.action ?? "");
  if (!["enable", "disable", "status"].includes(action)) throw new Error("Attention pulse action must be enable, disable, or status");
  if (runtime.sharedConversation && action === "enable") throw new Error("Attention pulse must be enabled from your private Chusky chat");
  const active = (await listJobs(userId)).filter((job) => job.kind === "attention_pulse");
  if (action === "status") return { enabled: active.length > 0, jobs: active };
  if (action === "disable") {
    for (const job of active) await cancelJob(userId, job.id);
    return { enabled: false, cancelled: active.map((job) => job.id) };
  }
  const existing = active.find((job) => job.id === ATTENTION_PULSE_JOB_ID(userId));
  if (existing) return existing;
  const qstashToken = requireQStash();
  const cron = validateCronExpression(args.cron ? text(args.cron) : "0 * * * *");
  await ensureAttentionPulseDeliveryPreference(userId, runtime);
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const job: JobRecord = {
    id: ATTENTION_PULSE_JOB_ID(userId), userId,
    text: "Run the owner's proactive attention pulse.", cron,
    scheduleId: ATTENTION_PULSE_SCHEDULE_ID(userId), status: "active", kind: "attention_pulse",
    workerBinding: ATTENTION_PULSE_BINDING,
    ...(deliveryTarget ? { deliveryTarget } : {}), createdAt: Date.now(),
  };
  const client = new QStashClient({ token: qstashToken });
  await addJob(userId, job);
  try {
    await client.schedules.create({
      scheduleId: job.scheduleId,
      destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
      body: JSON.stringify({ jobId: job.id, userId }), headers: { "Content-Type": "application/json" },
      cron, retries: 3, retryDelay: "1000 * (1 + retried)",
      ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
    });
  } catch (error) {
    await updateJob(userId, job.id, { status: "cancelled", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return job;
}

function futureTimestamp(args: Record<string, unknown>): number {
  const now = Date.now();
  const delay = Number(args.delaySeconds ?? 0);
  const parsed = args.runAt ? Date.parse(String(args.runAt)) : NaN;
  const runAt = Number.isFinite(parsed) ? parsed : now + delay * 1000;
  if (!Number.isFinite(runAt) || runAt <= now) throw new Error("Reminder time must be in the future (use runAt ISO or delaySeconds)");
  if (runAt > now + 365 * 24 * 60 * 60 * 1000) throw new Error("Reminder cannot be more than one year ahead");
  return runAt;
}

function durableReminderTarget(target: NativeToolRuntime["deliveryTarget"]): ReminderDeliveryTarget | undefined {
  if (!target?.provider || !target.conversationId) return undefined;
  const metadata = target.metadata
    ? Object.fromEntries(Object.entries(target.metadata).filter(([key]) => key === "groupId" || key === "groupParticipants"))
    : undefined;
  return {
    provider: target.provider,
    conversationId: target.conversationId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

function autonomyMode(args: Record<string, unknown>, fallback: AutonomyMode = "notify", allowWait = false): AutonomyMode {
  const candidate = typeof args.mode === "string" ? args.mode : fallback;
  const allowed: AutonomyMode[] = allowWait ? ["notify", "check_in", "act", "wait_until"] : ["notify", "check_in", "act"];
  return allowed.includes(candidate as AutonomyMode) ? candidate as AutonomyMode : fallback;
}

function autonomyLinks(args: Record<string, unknown>): AutonomyLinks | undefined {
  if (!args.links || typeof args.links !== "object" || Array.isArray(args.links)) return undefined;
  const input = args.links as Record<string, unknown>;
  const allowed = ["taskId", "missionId", "missionStepId", "openLoopId", "attentionCandidateId", "projectId", "meetingId", "conversationId"] as const;
  const links: AutonomyLinks = {};
  for (const key of allowed) if (typeof input[key] === "string" && input[key].trim()) links[key] = input[key].trim().slice(0, 160);
  return Object.keys(links).length ? links : undefined;
}

function boundedAutonomyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8).map((item) => item.trim().slice(0, 500));
}

export async function setReminder(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<ReminderRecord> {
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const mode = autonomyMode(args, "notify", true);
  const links = autonomyLinks(args);
  const reminder: ReminderRecord = {
    id: `rem_${randomUUID()}`,
    userId,
    text: text(args.text),
    runAt: futureTimestamp(args),
    status: "scheduled",
    ...(mode !== "notify" ? { mode } : {}),
    ...(links ? { links } : {}),
    ...(typeof args.nextAction === "string" && args.nextAction.trim() ? { nextAction: text(args.nextAction) } : {}),
    ...(mode === "wait_until" && Number.isFinite(Number(args.pollEverySeconds)) ? { pollEverySeconds: Math.max(60, Math.min(7 * 24 * 60 * 60, Math.floor(Number(args.pollEverySeconds)))) } : {}),
    ...(boundedAutonomyList(args.preconditions) ? { preconditions: boundedAutonomyList(args.preconditions) } : {}),
    ...(boundedAutonomyList(args.postconditions) ? { postconditions: boundedAutonomyList(args.postconditions) } : {}),
    ...(mode !== "notify" ? { contextSnapshot: { capturedAt: Date.now(), objective: text(args.text), ...(links ? { links } : {}), source: "user" as const } } : {}),
    ...(deliveryTarget ? { deliveryTarget } : {}),
    createdAt: Date.now(),
  };
  await addReminder(userId, reminder);
  try {
    const workflow = await enqueueReminderWorkflow(userId, reminder, Math.max(1, Math.ceil((reminder.runAt - Date.now()) / 1000)), reminder.id);
    reminder.workflowRunId = workflow.workflowRunId;
    await updateReminder(userId, reminder.id, { workflowRunId: reminder.workflowRunId });
  } catch (error) {
    await updateReminder(userId, reminder.id, { status: "failed", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return reminder;
}

async function enqueueReminderWorkflow(userId: number, reminder: ReminderRecord, delaySeconds: number, workflowRunId: string, attemptId?: string) {
  return new WorkflowClient({ token: requireQStash(), baseUrl: config.qstashUrl || undefined }).trigger({
    url: workflowUrl(config.reminderWorkflowUrl, "REMINDER_WORKFLOW_URL", "/workflows/reminder"),
    body: { reminderId: reminder.id, userId, ...(attemptId ? { attemptId } : {}) },
    delay: Math.max(1, Math.floor(delaySeconds)),
    workflowRunId,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
  });
}

export async function cancelReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  await updateReminder(userId, id, { status: "cancelled" });
  return `Reminder ${id} cancelled.`;
}

export async function pauseReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (["sent", "cancelled", "failed"].includes(reminder.status)) throw new Error(`Cannot pause a ${reminder.status} reminder`);
  if (reminder.status === "paused") return `Reminder ${id} is already paused.`;
  await updateReminder(userId, id, { status: "paused", deliveryError: undefined });
  return `Reminder ${id} paused.`;
}

export async function resumeReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (reminder.status !== "paused") return reminder.status === "scheduled" || reminder.status === "waiting" ? `Reminder ${id} is already active.` : `Cannot resume a ${reminder.status} reminder`;
  const runAt = Math.max(Date.now() + 1_000, reminder.runAt);
  await updateReminder(userId, id, { status: "scheduled", runAt, deliveryError: undefined });
  try {
    const workflow = await enqueueReminderWorkflow(userId, { ...reminder, status: "scheduled", runAt }, Math.ceil((runAt - Date.now()) / 1000), `${id}-resume-${randomUUID()}`, `resume-${randomUUID()}`);
    await updateReminder(userId, id, { workflowRunId: workflow.workflowRunId });
  } catch (error) {
    await updateReminder(userId, id, { status: "paused", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return `Reminder ${id} resumed.`;
}

export async function runReminderNow(userId: number, id: string): Promise<{ reminderId: string; workflowRunId: string }> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (["sent", "cancelled", "failed"].includes(reminder.status)) throw new Error(`Cannot run a ${reminder.status} reminder`);
  const next = { ...reminder, status: "scheduled" as const, runAt: Date.now() + 1_000 };
  await updateReminder(userId, id, { status: next.status, runAt: next.runAt, deliveryError: undefined });
  try {
    const workflow = await enqueueReminderWorkflow(userId, next, 1, `${id}-manual-${randomUUID()}`, `manual-${randomUUID()}`);
    await updateReminder(userId, id, { workflowRunId: workflow.workflowRunId });
    return { reminderId: id, workflowRunId: workflow.workflowRunId };
  } catch (error) {
    await updateReminder(userId, id, { status: reminder.status, deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
}

export async function scheduleJob(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<JobRecord> {
  const cron = validateCronExpression(text(args.cron));
  const jobText = text(args.text);
  const workerBinding: ScheduledWorkerBinding | undefined = runtime.worker && runtime.workerBinding
    ? { worker: runtime.worker, objective: jobText, ...runtime.workerBinding }
    : undefined;
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const mode = autonomyMode(args, workerBinding ? "act" : "notify");
  const links = autonomyLinks(args);
  const job: JobRecord = { id: `job_${randomUUID()}`, userId, text: jobText, cron, scheduleId: `chuck-${userId}-${randomUUID()}`, status: "active", ...(mode !== "notify" ? { mode } : {}), ...(links ? { links } : {}), ...(typeof args.nextAction === "string" && args.nextAction.trim() ? { nextAction: text(args.nextAction) } : {}), ...(boundedAutonomyList(args.preconditions) ? { preconditions: boundedAutonomyList(args.preconditions) } : {}), ...(boundedAutonomyList(args.postconditions) ? { postconditions: boundedAutonomyList(args.postconditions) } : {}), ...(mode !== "notify" ? { contextSnapshot: { capturedAt: Date.now(), objective: jobText, ...(links ? { links } : {}), source: "user" as const } } : {}), ...(workerBinding ? { workerBinding } : {}), ...(deliveryTarget ? { deliveryTarget } : {}), createdAt: Date.now() };
  const client = new QStashClient({ token: requireQStash() });
  await addJob(userId, job);
  try { await client.schedules.create({
    scheduleId: job.scheduleId,
    destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
    body: JSON.stringify({ jobId: job.id, userId }),
    headers: { "Content-Type": "application/json" },
    cron,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
  }); } catch (error) {
    await updateJob(userId, job.id, { status: "cancelled", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return job;
}

export async function cancelJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  // Flip durable state first: an already-queued QStash invocation must observe
  // cancellation and skip, even if schedule deletion races or is delayed.
  await updateJob(userId, id, { status: "cancelled" });
  const client = new QStashClient({ token: requireQStash() });
  try { await client.schedules.delete(job.scheduleId); }
  catch (error) {
    // The schedule may already be gone. Keep the cancellation authoritative;
    // a stray delivery will re-read the record and be safely ignored.
    throw new Error(`Recurring job cancelled locally but QStash schedule removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} cancelled.`;
}

export async function pauseJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status === "cancelled") throw new Error("Cannot pause a cancelled job");
  if (job.status === "paused") return `Recurring job ${id} is already paused.`;
  await updateJob(userId, id, { status: "paused", deliveryError: undefined });
  try {
    await new QStashClient({ token: requireQStash() }).schedules.pause({ schedule: job.scheduleId });
  } catch (error) {
    await updateJob(userId, id, { status: "active", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw new Error(`Recurring job was not paused: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} paused.`;
}

export async function resumeJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status === "cancelled") throw new Error("Cannot resume a cancelled job");
  if (job.status === "active") return `Recurring job ${id} is already active.`;
  await updateJob(userId, id, { status: "active", deliveryError: undefined });
  try {
    await new QStashClient({ token: requireQStash() }).schedules.resume({ schedule: job.scheduleId });
  } catch (error) {
    await updateJob(userId, id, { status: "paused", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw new Error(`Recurring job was not resumed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} resumed.`;
}

export async function runJobNow(userId: number, id: string): Promise<{ jobId: string; occurrenceId: string; workflowRunId: string }> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status !== "active") throw new Error("Resume the job before running it");
  const occurrenceId = `manual-${randomUUID()}`;
  const workflow = await new WorkflowClient({ token: requireQStash(), baseUrl: config.qstashUrl || undefined }).trigger({
    url: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
    body: { jobId: job.id, userId, occurrenceId },
    delay: 1,
    workflowRunId: `job-${job.id}-${occurrenceId}`,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-job-user-${userId}`, parallelism: 1, rate: 1, period: "1s" },
  });
  return { jobId: job.id, occurrenceId, workflowRunId: workflow.workflowRunId };
}

export async function nativeTool(userId: number, slug: string, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<unknown> {
  if (slug === "CHUCK_REQUEST_ADDITIONAL_TOOLS" && !runtime.worker) {
    throw new Error("CHUCK_REQUEST_ADDITIONAL_TOOLS is reserved for specialist workers; Chusky must search and verify the capability directly.");
  }
  if (slug === "CHUCK_REVIEW_SUBAGENT_ACTION" && runtime.worker) {
    throw new Error("Only Chusky can review specialist actions.");
  }
  switch (slug) {
    case "CHUCK_SEARCH_SKILLS": return searchSkills(text(args.query), args.limit === undefined ? 5 : Number(args.limit));
    case "CHUCK_LIST_SKILL_FILES": return listSkillFiles(text(args.name), args.maxFiles === undefined ? 100 : Number(args.maxFiles));
    case "CHUCK_READ_SKILL_FILE": return readSkillFile(text(args.name), args.path === undefined ? "SKILL.md" : text(args.path), args.maxChars === undefined ? 12_000 : Number(args.maxChars));
    case "CHUCK_SET_REMINDER": return setReminder(userId, args, runtime);
    case "CHUCK_LIST_REMINDERS": return listReminders(userId);
    case "CHUCK_CANCEL_REMINDER": return cancelReminder(userId, text(args.id));
    case "CHUCK_PAUSE_REMINDER": return pauseReminder(userId, text(args.id));
    case "CHUCK_RESUME_REMINDER": return resumeReminder(userId, text(args.id));
    case "CHUCK_RUN_REMINDER_NOW": return runReminderNow(userId, text(args.id));
    case "CHUCK_SCHEDULE_JOB": return scheduleJob(userId, args, runtime);
    case "CHUCK_ATTENTION_PULSE": return configureAttentionPulse(userId, args, runtime);
    case "CHUCK_LIST_JOBS": return listJobs(userId);
    case "CHUCK_PAUSE_JOB": return pauseJob(userId, text(args.id));
    case "CHUCK_RESUME_JOB": return resumeJob(userId, text(args.id));
    case "CHUCK_RUN_JOB_NOW": return runJobNow(userId, text(args.id));
    case "CHUCK_CANCEL_JOB": return cancelJob(userId, text(args.id));
    case "CHUCK_SCRATCHPAD_WRITE": await writeScratchpad(userId, text(args.key), text(args.content)); return { saved: true, key: args.key };
    case "CHUCK_SCRATCHPAD_READ": return readScratchpad(userId, args.query ? String(args.query) : undefined);
    case "CHUCK_SCRATCHPAD_CLEAR": await clearScratchpad(userId, args.key ? text(args.key) : undefined); return { cleared: true };
    case "CHUCK_SAVE_MEMORY": {
      if (args.sensitivity !== "normal" && args.sensitivity !== "sensitive") throw new Error("sensitivity is required when saving memory");
      const category = (args.category as string) ?? "fact";
      const memory = await upsertMemory(userId, { category: category as any, key: text(args.key), value: text(args.value), source: args.source ? text(args.source) : undefined, confidence: Number(args.confidence ?? 1), sensitivity: args.sensitivity, projectId: args.projectId ? text(args.projectId) : undefined, personKey: args.personKey ? text(args.personKey) : undefined, reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt), expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt) });
      const contextKind = ["preference", "relationship", "fact", "decision", "objective", "open_loop"].includes(category) ? category : "memory";
      const context = await upsertContextNode(userId, { scope: args.projectId ? "project" : "user", ...(args.projectId ? { scopeId: text(args.projectId) } : {}), kind: contextKind as never, key: text(args.key), value: text(args.value), source: args.source ? text(args.source) : "CHUCK_SAVE_MEMORY", sourceRef: memory.id, sensitivity: args.sensitivity, confidence: Number(args.confidence ?? 1), ...(args.reviewAt !== undefined ? { reviewAt: Number(args.reviewAt) } : {}), ...(args.expiresAt !== undefined ? { expiresAt: Number(args.expiresAt) } : {}) });
      return { ...memory, contextNodeId: context.id };
    }
    case "CHUCK_SEARCH_MEMORY": return searchMemories(userId, args.query ? String(args.query) : undefined, { category: args.category as any, projectId: args.projectId ? text(args.projectId) : undefined, personKey: args.personKey ? text(args.personKey) : undefined, limit: args.limit === undefined ? undefined : Number(args.limit) });
    case "CHUCK_UPDATE_MEMORY": {
      if (!args.id && !args.key) throw new Error("CHUCK_UPDATE_MEMORY requires id or key");
      const updated = await updateMemory(userId, { id: args.id ? text(args.id) : undefined, key: args.key ? text(args.key) : undefined, category: args.category as any }, {
        category: args.newCategory as any,
        key: args.newKey ? text(args.newKey) : undefined,
        value: text(args.value),
        source: args.source ? text(args.source) : undefined,
        confidence: args.confidence === undefined ? undefined : Number(args.confidence),
        sensitivity: args.sensitivity === "sensitive" ? "sensitive" : args.sensitivity === "normal" ? "normal" : undefined,
        projectId: args.projectId ? text(args.projectId) : undefined,
        personKey: args.personKey ? text(args.personKey) : undefined,
        reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt),
        expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt),
      });
      return updated ?? { updated: false, reason: "Memory not found" };
    }
    case "CHUCK_SAVE_IMAGE_ASSET": {
      const images = args.source === "generated" ? runtime.generatedImages : runtime.currentImages;
      const image = images?.[Math.max(0, Math.floor(Number(args.sourceIndex ?? 0)))];
      if (!image) throw new Error("No current image is available to save");
      const contentType = image.mediaType.toLowerCase();
      if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") throw new Error("Only JPEG, PNG, and WebP images can be saved");
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [];
      return { imageAssetSaved: true, asset: await saveImageAsset(userId, { name: text(args.name), purpose: text(args.purpose), description: args.description ? text(args.description) : undefined, tags, contentType }, image.data) };
    }
    case "CHUCK_SEARCH_IMAGE_ASSETS": return searchImageAssets(userId, args.query ? text(args.query) : undefined, args.limit === undefined ? 5 : Number(args.limit));
    case "CHUCK_GET_IMAGE_ASSET": {
      const asset = await getImageAsset(userId, text(args.id));
      if (!asset) return { found: false };
      return { __chuskyImageAsset: true, ...asset };
    }
    case "CHUCK_FORGET_IMAGE_ASSET": return { forgotten: await forgetImageAsset(userId, text(args.id)) };
    case "CHUCK_FORGET_MEMORY": return { forgotten: await forgetMemory(userId, text(args.key)) };
    case "CHUCK_ATTENTION_STATE": return attentionTool(userId, args);
    case "CHUCK_START_PHONE_CALL": {
      const profile = args.profile && typeof args.profile === "object" && !Array.isArray(args.profile) ? args.profile as Record<string, unknown> : undefined;
      const callProfile: "business" | "personal" = args.callProfile === "business" ? "business" : "personal";
      const input = { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose), ...(profile ? { profile } : {}), callProfile };
      if (phoneCallLauncherForTests) return phoneCallLauncherForTests(userId, input);
      return config.blandVoiceEnabled
        ? startBlandCallForUser(userId, input)
        : startTwilioCallForUser(userId, input);
    }
    case "CHUCK_LIST_PHONE_CALLS": return listPhoneCalls(userId);
    case "CHUCK_MEETING_CONTEXT_PREPARE": {
      if (runtime.sharedConversation) throw new Error("Client meeting preparation is available only in a private owner conversation");
      return prepareRecallMeetingMission(userId, { clientName: args.clientName, objective: args.objective, clientContext: args.clientContext });
    }
    case "CHUCK_MEETING_CONTEXT_LOOKUP": {
      if (!runtime.meetingId) throw new Error("CHUCK_MEETING_CONTEXT_LOOKUP is available only inside an active meeting");
      return lookupRecallMeetingContext(userId, runtime.meetingId, text(args.query));
    }
    case "CHUCK_MEETING_CONTACT_CAPTURE": {
      if (!runtime.meetingId || runtime.sharedConversation) throw new Error("Meeting contact capture is available only inside an active representative meeting");
      const meeting = await getRecallMeeting(userId, runtime.meetingId);
      if (!meeting || meeting.interactionMode !== "representative" || !["joining", "waiting_room", "in_call"].includes(meeting.status)) {
        throw new Error("Meeting not found or is not an active representative meeting owned by this account");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      if (!profile.enabled) throw new Error("The meeting representative profile is not enabled");
      return upsertMeetingContact(userId, meeting.id, {
        participantName: args.participantName,
        email: args.email,
        phone: args.phone,
        contactPreference: args.contactPreference,
        interest: args.interest,
        nextStep: args.nextStep,
        followUpAt: args.followUpAt,
      });
    }
    case "CHUCK_MEETING_CONTACTS_LIST": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting contacts are available only in a private owner conversation");
      return listMeetingContacts(userId, args.limit === undefined ? 20 : Number(args.limit));
    }
    case "CHUCK_MEETING_CONTACT_DELETE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting contacts are available only in a private owner conversation");
      const id = text(args.id);
      const existing = await getMeetingContact(userId, id);
      if (existing?.followUpTaskId) await cancelTask(userId, existing.followUpTaskId);
      return { deleted: await deleteMeetingContact(userId, id), id };
    }
    case "CHUCK_MEETING_FOLLOWUP_SCHEDULE": {
      if (!runtime.meetingId || runtime.sharedConversation) throw new Error("Delayed meeting follow-up is available only from its owned representative meeting workflow");
      const meeting = await getRecallMeeting(userId, runtime.meetingId);
      if (!meeting || meeting.interactionMode !== "representative" || !["joining", "waiting_room", "in_call", "leaving", "ended"].includes(meeting.status)) {
        throw new Error("Meeting not found or is not an owned representative meeting");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      if (!profile.enabled) throw new Error("Delayed meeting follow-up is not enabled for this representative");
      const contact = await getMeetingContact(userId, text(args.contactId), meeting.id);
      if (!contact) throw new Error("Contact was not captured in this meeting");
      if (!contact.email || contact.contactPreference === "phone") throw new Error("This contact prefers phone or has no email, so Chusky cannot schedule an email follow-up");
      const emailTool = profile.allowedComposioTools.find(isMeetingRepresentativeEmailTool);
      if (!emailTool) throw new Error("Add an exact connected email-send action to the representative profile before scheduling an email follow-up");
      const runAt = futureTimestamp(args);
      const taskId = `task_mf_${createHash("sha256").update(`${userId}:${meeting.id}:${contact.id}:${runAt}`).digest("hex").slice(0, 32)}`;
      const task = await createTask(userId, {
        id: taskId,
        title: `Follow up with ${contact.participantName}`.slice(0, 120),
        objective: `Send the agreed follow-up email to captured meeting contact ${contact.id}. Use only that person's recorded interest and next step.`,
        runAt,
        meetingFollowUp: { meetingId: meeting.id, contactId: contact.id, emailTool, state: "scheduled" },
      });
      if (task.status === "completed" || task.status === "cancelled") throw new Error("This delayed follow-up task is already closed");
      if (!task.workflowRunId) {
        await scheduleTask(userId, task.id, runAt);
        await setTaskWorkflowRunId(userId, task.id, await enqueueTaskWorkflow(userId, task.id, runAt));
      }
      await updateMeetingContact(userId, contact.id, { followUpTaskId: task.id, followUpAt: runAt });
      return { scheduled: true, taskId: task.id, participantName: contact.participantName, runAt: new Date(runAt).toISOString(), emailTool };
    }
    case "CHUCK_MEETING_PREPARATION_LIST": {
      if (runtime.sharedConversation) throw new Error("Calendar meeting preparations are available only in a private owner conversation");
      return listCalendarMeetingPreparations(userId, args.limit === undefined ? 10 : Number(args.limit));
    }
    case "CHUCK_MEETING_PREPARATION_JOIN": {
      if (runtime.sharedConversation) throw new Error("Calendar meetings can be joined only from a private owner conversation");
      return joinPreparedCalendarMeeting(userId, text(args.id), runtime.signal);
    }
    case "CHUCK_MEETING_JOIN": {
      if (runtime.sharedConversation && (args.clientName !== undefined || args.objective !== undefined || args.clientContext !== undefined)) {
        throw new Error("Client-bound meetings must be prepared from a private owner conversation");
      }
      if (runtime.sharedConversation && args.transcriptRetentionDays !== undefined) {
        throw new Error("Searchable meeting transcript retention can be enabled only from a private owner conversation");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      const hasClientMission = hasMeetingMissionInput(args);
      const interactionMode = hasClientMission ? "representative" : args.interactionMode ?? (profile.enabled ? "representative" : "copilot");
        const transcriptRetentionDays = ownerExplicitlyRequestedTranscriptRetention(runtime.userRequest ?? "")
          ? args.transcriptRetentionDays
          : undefined;
        return joinRecallMeeting(userId, {
          meetingUrl: args.meetingUrl, title: args.title, joinAt: args.joinAt, interactionMode, analyzeScreenShare: args.analyzeScreenShare,
          ...(transcriptRetentionDays !== undefined ? { transcriptRetentionDays } : {}),
        clientName: args.clientName, objective: args.objective, clientContext: args.clientContext, clientContextConfirmed: args.clientContextConfirmed,
        ...(runtime.meetingId && args.clientName === undefined ? { inheritMeetingId: runtime.meetingId } : {}),
      }, runtime.signal);
    }
    case "CHUCK_MEETING_PROFILE_GET": return getMeetingRepresentativeProfile(userId);
    case "CHUCK_MEETING_PROFILE_UPDATE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting representative settings can be changed only in a private owner conversation");
      const previous = await getMeetingRepresentativeProfile(userId);
      const updated = await updateMeetingRepresentativeProfile(userId, args);
      if (!updated.autoJoinCalendar && (previous.autoJoinCalendar || args.autoJoinCalendar === false || args.enabled === false)) {
        const cleanup = await cancelAutomaticCalendarMeetingJoins(userId);
        return { ...updated, automaticJoinCleanup: cleanup };
      }
      return updated;
    }
    case "CHUCK_MEETING_LIST": return listRecallMeetingsForUser(userId, args.limit === undefined ? 10 : Number(args.limit));
    case "CHUCK_MEETING_STATUS": {
      const meeting = await getRecallMeetingForUser(userId, text(args.id));
      return meeting ?? { found: false, reason: "Meeting not found or not owned by you" };
    }
    case "CHUCK_MEETING_TRANSCRIPT_SEARCH": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting transcripts can be searched only in a private owner conversation");
      const results = await searchRecallMeetingTranscripts(userId, text(args.query), args.meetingId === undefined ? undefined : text(args.meetingId), args.limit === undefined ? 5 : Number(args.limit));
      return { results, count: results.length, ...(results.length ? {} : { message: "No matching unexpired, owner-retained meeting transcript was found." }) };
    }
    case "CHUCK_MEETING_TRANSCRIPT_DELETE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting transcripts can be deleted only in a private owner conversation");
      const deleted = await deleteRecallMeetingTranscript(userId, text(args.meetingId));
      if (!deleted) throw new Error("No retained transcript was found for that ended meeting");
      return { deleted: true, meetingId: text(args.meetingId) };
    }
    case "CHUCK_MEETING_LEAVE": return leaveRecallMeeting(userId, text(args.id), runtime.signal);
    case "CHUCK_VIDEO_STATUS": {
      const id = args.id ? text(args.id) : undefined;
      const limit = args.limit === undefined ? 5 : Math.max(1, Math.min(10, Math.floor(Number(args.limit))));
      const jobs = await listVideoJobs(userId);
      return jobs.filter((job) => !id || job.id === id).slice(0, limit);
    }
    case "CHUCK_TASK_CREATE": return createTask(userId, { title: text(args.title), objective: text(args.objective), workspaceId: args.workspaceId ? text(args.workspaceId) : undefined });
    case "CHUCK_TASK_LIST": return listTasks(userId, taskStatuses(args.statuses));
    case "CHUCK_TASK_GET": {
      const task = await getTask(userId, text(args.id));
      if (!task) throw new Error("Task not found or not owned by you");
      return task;
    }
    case "CHUCK_TASK_CHECKPOINT": {
      const task = await checkpointTask(userId, text(args.id), text(args.checkpoint), args.nextAction ? text(args.nextAction) : undefined);
      if (!task) throw new Error("Only unfinished tasks you own can be checkpointed");
      return task;
    }
    case "CHUCK_TASK_BLOCK": {
      const task = await blockTask(userId, text(args.id), text(args.reason), args.nextAction ? text(args.nextAction) : undefined);
      if (!task) throw new Error("Only unfinished tasks you own can be blocked");
      return task;
    }
    case "CHUCK_TASK_COMPLETE": {
      const task = await completeTask(userId, text(args.id), text(args.result));
      if (!task) throw new Error("Only unfinished tasks you own can be completed");
      return task;
    }
    case "CHUCK_TASK_CANCEL": {
      const task = await cancelTask(userId, text(args.id));
      if (!task) throw new Error("Only unfinished tasks you own can be cancelled");
      return task;
    }
    case "CHUCK_TASK_RETRY": {
      const task = await retryTask(userId, text(args.id));
      if (!task) throw new Error("Only failed, blocked, or cancelled tasks you own can be retried");
      return task;
    }
    case "CHUCK_TASK_SCHEDULE": {
      const id = text(args.id);
      const task = await getTask(userId, id);
      if (!task) throw new Error("Task not found or not owned by you");
      const runAt = futureTimestamp(args);
      await scheduleTask(userId, id, runAt);
      await setTaskWorkflowRunId(userId, id, await enqueueTaskWorkflow(userId, id, runAt));
      return await getTask(userId, id);
    }
    case "CHUCK_TASK_WAIT": {
      if (!runtime.taskId || !runtime.requestTaskWait) throw new Error("CHUCK_TASK_WAIT is only available inside an active durable task");
      const request: TaskWaitRequest = createTaskWaitRequest(args);
      runtime.requestTaskWait(request);
      return { waiting: true, taskId: runtime.taskId, runAt: new Date(request.runAt).toISOString(), checkpoint: request.checkpoint, nextAction: request.nextAction, ...(request.reason ? { reason: request.reason } : {}) };
    }
    case "CHUCK_MISSION_START": {
      const mission = await createMission(userId, {
        title: text(args.title), objective: text(args.objective), definitionOfDone: text(args.definitionOfDone),
        idempotencyKey: args.idempotencyKey ? text(args.idempotencyKey) : undefined,
        requiredEvidence: Array.isArray(args.requiredEvidence) ? args.requiredEvidence.filter((value: unknown): value is string => typeof value === "string") : undefined,
        verificationMode: args.verificationMode === "strict" || (args.verificationMode === undefined && Array.isArray(args.requiredEvidence) && args.requiredEvidence.length > 0) ? "strict" : "legacy",
        steps: Array.isArray(args.steps) ? args.steps.map((step: Record<string, unknown>) => ({ id: typeof step.id === "string" ? step.id : undefined, title: text(step.title), objective: text(step.objective), dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((value: unknown): value is string => typeof value === "string") : undefined, retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit), input: step.input && typeof step.input === "object" ? step.input as Record<string, unknown> : undefined, outputSchema: step.outputSchema && typeof step.outputSchema === "object" ? step.outputSchema as Record<string, unknown> : undefined, evidenceRequired: Array.isArray(step.evidenceRequired) ? step.evidenceRequired.filter((value: unknown): value is string => typeof value === "string") : undefined, compensationObjective: typeof step.compensationObjective === "string" ? step.compensationObjective : undefined, retryBackoffSeconds: step.retryBackoffSeconds === undefined ? undefined : Number(step.retryBackoffSeconds), parallelGroup: typeof step.parallelGroup === "string" ? step.parallelGroup : undefined })) : undefined,
        budget: {
          maxDurationSeconds: args.maxDurationSeconds === undefined ? undefined : Number(args.maxDurationSeconds),
          maxSteps: args.maxSteps === undefined ? undefined : Number(args.maxSteps),
          maxToolCalls: args.maxToolCalls === undefined ? undefined : Number(args.maxToolCalls),
          maxCost: args.maxCost === undefined ? undefined : Number(args.maxCost),
        },
      });
      if (mission.status === "queued") {
        const started = await startMission(userId, mission.id);
        if (started && !started.rootTaskId) {
          try {
            return (await scheduleMissionSteps(userId, started, enqueueTaskWorkflow)) ?? started;
          } catch (error) {
            await blockMission(userId, started.id, `Mission could not be scheduled: ${error instanceof Error ? error.message : String(error)}`, "Retry after the durable workflow service is available.");
            throw error;
          }
        }
        if (started) return started;
      }
      return mission;
    }
    case "CHUCK_MISSION_LIST": return listMissions(userId, missionStatuses(args.statuses));
    case "CHUCK_MISSION_GET": {
      const mission = await getMission(userId, text(args.id));
      if (!mission) throw new Error("Mission not found or not owned by you");
      return mission;
    }
    case "CHUCK_MISSION_PROOF": {
      const mission = await getMission(userId, text(args.id));
      if (!mission) throw new Error("Mission not found or not owned by you");
      return missionProof(mission);
    }
    case "CHUCK_MISSION_CHECKPOINT": {
      const mission = await checkpointMission(userId, text(args.id), text(args.checkpoint), args.nextAction ? text(args.nextAction) : undefined);
      if (!mission) throw new Error("Only running missions you own can be checkpointed");
      return mission;
    }
    case "CHUCK_MISSION_PAUSE": {
      const mission = await pauseMission(userId, text(args.id), args.reason ? text(args.reason) : undefined);
      if (!mission) throw new Error("Only running or waiting missions you own can be paused");
      await cancelMissionTasks(userId, mission.id);
      return mission;
    }
    case "CHUCK_MISSION_RESUME": {
      const mission = await resumeMission(userId, text(args.id));
      if (!mission) throw new Error("Only paused, blocked, or failed missions you own can be resumed");
      return (await scheduleMissionSteps(userId, mission, enqueueTaskWorkflow)) ?? mission;
    }
    case "CHUCK_MISSION_CANCEL": {
      const mission = await cancelMission(userId, text(args.id), args.reason ? text(args.reason) : undefined);
      if (!mission) throw new Error("Only unfinished missions you own can be cancelled");
      await cancelMissionTasks(userId, mission.id);
      return mission;
    }
    case "CHUCK_MISSION_WAIT_EVENT": {
      const mission = await getMission(userId, text(args.id));
      if (!mission || !["running", "waiting"].includes(mission.status)) throw new Error("Only a running mission you own can wait for a provider event");
      const provider = text(args.provider).slice(0, 120);
      const providerEventId = text(args.providerEventId).slice(0, 240);
      const request: MissionWaitRequest = { provider, providerEventId, stepId: args.stepId ? text(args.stepId) : mission.currentStepId, checkpoint: args.checkpoint ? text(args.checkpoint) : mission.checkpoint, nextAction: args.nextAction ? text(args.nextAction) : `Waiting for ${provider} event ${providerEventId}.`, timeoutSeconds: args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds) };
      runtime.requestMissionWait?.(request);
      return { status: "waiting", provider, providerEventId, nextAction: request.nextAction };
    }
    case "CHUCK_MISSION_STEP_COMPLETE": {
      const mission = await completeMissionStep(userId, text(args.id), text(args.stepId), text(args.result));
      if (!mission) throw new Error("Only a pending or running step in an unfinished mission you own can be completed");
      return mission;
    }
    case "CHUCK_MISSION_EVIDENCE": {
      const rawEvidence = Array.isArray(args.evidence) ? args.evidence : [];
      if (!rawEvidence.length) throw new Error("At least one evidence record is required");
      const evidence = rawEvidence.map((item: Record<string, unknown>) => ({ id: `evidence_${randomUUID()}`, kind: text(item.kind) as "source", summary: text(item.summary), ...(item.source ? { source: text(item.source) } : {}), ...(item.ref ? { ref: text(item.ref) } : {}), ...(item.hash ? { hash: text(item.hash) } : {}), verified: item.verified === true, ...(item.verifiedBy ? { verifiedBy: text(item.verifiedBy) as "agent" } : {}) }));
      const mission = await recordMissionEvidence(userId, text(args.id), evidence, args.stepId ? text(args.stepId) : undefined);
      if (!mission) throw new Error("Mission not found, finished, or not owned by you");
      return mission;
    }
    case "CHUCK_MISSION_VERIFY": {
      const mission = await verifyMission(userId, text(args.id), { evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((value: unknown): value is string => typeof value === "string") : undefined, confidence: args.confidence === undefined ? undefined : Number(args.confidence), verifiedBy: args.verifiedBy === "human" || args.verifiedBy === "agent" ? args.verifiedBy : "system" });
      if (!mission) throw new Error("Mission not found or not owned by you");
      return mission;
    }
    case "CHUCK_MISSION_REPAIR": {
      const mission = await repairMission(userId, text(args.id), { reason: text(args.reason), nextAction: args.nextAction ? text(args.nextAction) : undefined });
      if (!mission) throw new Error("Mission not found, finished, or not owned by you");
      return mission;
    }
    case "CHUCK_CONTEXT_SEARCH": {
      const selection = { query: args.query ? text(args.query) : undefined, scope: args.scope as never, scopeId: args.scopeId ? text(args.scopeId) : undefined, purpose: args.purpose as never, limit: args.limit === undefined ? undefined : Number(args.limit) };
      return { nodes: await selectContext(userId, selection), prompt: await contextPrompt(userId, selection) };
    }
    case "CHUCK_CONTEXT_SAVE": {
      return upsertContextNode(userId, { scope: text(args.scope) as never, scopeId: args.scopeId ? text(args.scopeId) : undefined, kind: text(args.kind) as never, key: text(args.key), value: text(args.value), source: args.source ? text(args.source) : undefined, sourceRef: args.sourceRef ? text(args.sourceRef) : undefined, sensitivity: text(args.sensitivity) as "normal" | "sensitive", confidence: args.confidence === undefined ? undefined : Number(args.confidence), tags: Array.isArray(args.tags) ? args.tags.filter((value: unknown): value is string => typeof value === "string") : undefined, reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt), expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt) });
    }
    case "CHUCK_DEPARTMENT_HANDOFF": {
      return createDepartmentHandoff(userId, { department: text(args.department), objective: text(args.objective), inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, unknown> : {}, constraints: Array.isArray(args.constraints) ? args.constraints.filter((value: unknown): value is string => typeof value === "string") : [], evidenceRequired: Array.isArray(args.evidenceRequired) ? args.evidenceRequired.filter((value: unknown): value is string => typeof value === "string") : [], ...(args.outputSchema && typeof args.outputSchema === "object" ? { outputSchema: args.outputSchema as Record<string, unknown> } : {}), ...(args.toAgent ? { toAgent: text(args.toAgent) } : {}), ...(args.deadline ? { deadline: Number(args.deadline) } : {}), ...(args.approvalBoundary ? { approvalBoundary: text(args.approvalBoundary) } : {}) });
    }
    case "CHUCK_OUTCOME_LIST": return listOutcomePackages();
    case "CHUCK_OUTCOME_PLAN": return planOutcome(text(args.slug), args.input && typeof args.input === "object" ? args.input as Record<string, unknown> : {});
    case "CHUCK_MISSION_REPLAN": {
      const steps = Array.isArray(args.steps) ? args.steps.map((step: Record<string, unknown>) => ({
        id: typeof step.id === "string" ? step.id : undefined,
        title: text(step.title),
        objective: text(step.objective),
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((value: unknown): value is string => typeof value === "string") : undefined,
        retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit),
      })) : [];
      const mission = await replanMission(userId, text(args.id), steps, text(args.reason));
      if (!mission) throw new Error("Only an unfinished mission you own can be replanned");
      return mission;
    }
    case "CHUCK_MISSION_BLOCK": {
      const mission = await blockMission(userId, text(args.id), text(args.reason), args.nextAction ? text(args.nextAction) : undefined);
      if (!mission) throw new Error("Only unfinished missions you own can be blocked");
      return mission;
    }
    case "CHUCK_MISSION_COMPLETE": {
      const mission = await completeMission(userId, text(args.id), text(args.result));
      if (!mission) throw new Error("Only unfinished missions you own can be completed");
      return mission;
    }
    case "CHUCK_DAYTONA_WORKSPACE": return daytonaCall(runtime, () => daytonaEngine.workspace(userId, (args.action as "get" | "create" | "status" | "pause" | "archive") ?? "status"));
    case "CHUCK_DAYTONA_EXECUTE": return daytonaCall(runtime, () => daytonaEngine.execute(userId, daytonaCommand(args.command), args.cwd ? text(args.cwd) : undefined, args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds)));
    case "CHUCK_DAYTONA_LIST_FILES": return daytonaCall(runtime, () => daytonaEngine.listFiles(userId, args.path ? text(args.path) : undefined, args.depth === undefined ? undefined : Number(args.depth)));
    case "CHUCK_DAYTONA_READ_FILE": return daytonaCall(runtime, () => daytonaEngine.readFile(userId, text(args.path), args.maxChars === undefined ? undefined : Number(args.maxChars)));
    case "CHUCK_DAYTONA_WRITE_FILE": return daytonaCall(runtime, () => daytonaEngine.writeFile(userId, text(args.path), fileContent(args.content)));
    case "CHUCK_DAYTONA_FIND_FILES": return daytonaCall(runtime, () => daytonaEngine.findFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern)));
    case "CHUCK_DAYTONA_SEARCH_FILES": return daytonaCall(runtime, () => daytonaEngine.searchFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern)));
    case "CHUCK_DAYTONA_FILE_DETAILS": return daytonaCall(runtime, () => daytonaEngine.fileDetails(userId, text(args.path)));
    case "CHUCK_DAYTONA_CREATE_FOLDER": return daytonaCall(runtime, () => daytonaEngine.createFolder(userId, text(args.path)));
    case "CHUCK_DAYTONA_MOVE_FILES": return daytonaCall(runtime, () => daytonaEngine.moveFiles(userId, text(args.source), text(args.destination)));
    case "CHUCK_DAYTONA_DELETE_FILE": return daytonaCall(runtime, () => daytonaEngine.deleteFile(userId, text(args.path), args.recursive === true));
    case "CHUCK_DAYTONA_DELETE_WORKSPACE": return daytonaCall(runtime, () => daytonaEngine.deleteWorkspace(userId));
    case "CHUCK_DAYTONA_PREVIEW": return daytonaCall(runtime, () => daytonaEngine.preview(userId, Number(args.port)));
    case "CHUCK_DAYTONA_APP": return daytonaCall(runtime, () => daytonaEngine.app(userId, args));
    case "CHUCK_DAYTONA_CREATE_SNAPSHOT": return daytonaCall(runtime, () => daytonaEngine.createSnapshot(userId, text(args.name)));
    case "CHUCK_DAYTONA_COMPUTER": return daytonaCall(runtime, () => daytonaEngine.computer(userId, args));
    case "CHUCK_DAYTONA_PAUSE": return daytonaCall(runtime, () => daytonaEngine.pause(userId));
    case "CHUCK_DAYTONA_PTY": return (async () => {
      const result = await daytonaCall(runtime, () => daytonaEngine.pty(userId, args));
      if (runtime.registerCancellationCleanup && args.action === "create" && result && typeof result === "object" && typeof (result as { sessionId?: unknown }).sessionId === "string") {
        const ptyId = (result as { sessionId: string }).sessionId;
        runtime.registerCancellationCleanup(async () => { await daytonaEngine.pty(userId, { action: "kill", id: ptyId }); });
      }
      return result;
    })();
    case "CHUCK_DAYTONA_GIT": return daytonaCall(runtime, () => daytonaEngine.git(userId, args));
    case "CHUCK_BROWSER_PLAN": {
      const origin = args.origin ? normalizeBrowserOrigin(text(args.origin)) : undefined;
      const playbook = origin ? await findBrowserPlaybook(userId, origin, args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : "default") : undefined;
      const plan = createBrowserOperationPlan(text(args.goal), origin, playbook);
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "plan_created", ...(origin ? { origin } : {}), ...(playbook ? { service: playbook.service, playbookId: playbook.id } : {}), action: plan.action, status: "started", summary: `Planned ${plan.action.replaceAll("_", " ")} browser work`, createdAt: Date.now() });
      return { ...plan, ...(playbook ? { playbook: { id: playbook.id, service: playbook.service, accountAlias: playbook.accountAlias, version: playbook.version } } : {}) };
    }
    case "CHUCK_BROWSER_SESSION_HEALTH": {
      const service = args.service ? text(args.service) : undefined;
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const health = await browserSessionHealth(userId, service, origin);
      const expired = health.filter((item) => item.status === "expired" || item.status === "needs_reauth");
      for (const item of expired) {
        try {
          await logoutVault(userId, item.service, item.accountAlias, item.origin);
          await daytonaEngine.workspace(userId, "pause");
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service: item.service, origin: item.origin, status: "succeeded", summary: `Expired ${item.service} browser session was revoked and its workspace paused`, createdAt: Date.now() });
        } catch {
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service: item.service, origin: item.origin, status: "failed", summary: `Expired ${item.service} browser session needs manual revocation`, createdAt: Date.now() });
        }
      }
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_health_checked", ...(service ? { service } : {}), status: "succeeded", summary: `Checked ${health.length} saved browser session${health.length === 1 ? "" : "s"}`, createdAt: Date.now() });
      return health;
    }
    case "CHUCK_BROWSER_PLAYBOOK_SAVE": {
      assertSafeBrowserRecipe(args.login);
      assertSafeBrowserRecipe(args.tasks);
      const service = text(args.service).toLowerCase();
      const origin = normalizeBrowserOrigin(text(args.origin));
      const accountAlias = normalizeBrowserAlias(args.accountAlias);
      if (!args.login || typeof args.login !== "object" || Array.isArray(args.login)) throw new Error("login must be an object");
      const playbook = normalizePlaybook({ userId, service, origin, accountAlias, login: args.login as BrowserPlaybookRecord["login"], tasks: Array.isArray(args.tasks) ? args.tasks as BrowserPlaybookRecord["tasks"] : [] });
      await saveBrowserPlaybook(userId, playbook);
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "playbook_saved", service, origin, playbookId: playbook.id, status: "succeeded", summary: `Saved browser recipe for ${service}`, createdAt: Date.now() });
      return { id: playbook.id, service, origin, accountAlias, version: playbook.version, taskCount: playbook.tasks.length, lastVerifiedAt: playbook.login.lastVerifiedAt };
    }
    case "CHUCK_BROWSER_PLAYBOOK_LIST": {
      const origin = args.origin ? normalizeBrowserOrigin(text(args.origin)) : undefined;
      const playbooks = (await listBrowserPlaybooks(userId, args.limit === undefined ? 25 : Number(args.limit))).filter((item) => !origin || item.origin === origin);
      return playbooks.map((item) => ({ id: item.id, service: item.service, origin: item.origin, accountAlias: item.accountAlias, version: item.version, taskCount: item.tasks.length, successCount: item.successCount, failureCount: item.failureCount, lastUsedAt: item.lastUsedAt, loginLastVerifiedAt: item.login.lastVerifiedAt }));
    }
    case "CHUCK_BROWSER_PLAYBOOK_REMOVE": {
      const id = text(args.id);
      const removed = await removeBrowserPlaybook(userId, id);
      if (!removed) throw new Error("Browser playbook not found or not owned by you");
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", playbookId: id, status: "succeeded", summary: "Removed a saved browser playbook", createdAt: Date.now() });
      return { id, removed: true };
    }
    case "CHUCK_BROWSER_AUDIT_LIST": return listBrowserAudit(userId, args.limit === undefined ? 50 : Number(args.limit));
    case "CHUCK_BROWSER_VERIFY": {
      if (!Array.isArray(args.detectors)) throw new Error("detectors must be an array");
      const handoffId = args.handoffId ? text(args.handoffId) : undefined;
      if (handoffId && args.detectors.length === 0) throw new Error("A browser handoff requires at least one required verification detector");
      const result = verifyBrowserResult({
        currentUrl: args.currentUrl === undefined ? undefined : text(args.currentUrl).slice(0, 500),
        title: args.title === undefined ? undefined : text(args.title).slice(0, 300),
        text: args.text === undefined ? undefined : String(args.text).slice(0, 5000),
        detectors: args.detectors as Parameters<typeof verifyBrowserResult>[0]["detectors"],
      });
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: result.passed ? "verification_passed" : "verification_failed", status: result.passed ? "succeeded" : "failed", summary: result.passed ? "Browser result verification passed" : "Browser result verification needs review", createdAt: Date.now() });
      if (handoffId && result.passed) {
        const handoff = await getBrowserHandoff(userId, handoffId);
        if (!handoff) throw new Error("Browser handoff not found or not owned by you");
        if (!["waiting", "awaiting_verification"].includes(handoff.status)) throw new Error(`Browser handoff is ${handoff.status} and cannot be completed`);
        const credentials = await listVault(userId);
        const saved = credentials.find((credential) => credential.session?.workspaceId === handoff.workspaceId && credential.session.status === "awaiting_user_interaction" && (!handoff.origin || credential.origin === handoff.origin) && (!handoff.service || credential.service === handoff.service));
        if (!saved?.session) throw new Error("The retained browser session is not awaiting verification. Inspect the same browser and start a fresh vault login if necessary.");
        if (args.currentUrl && handoff.origin) {
          let verifiedOrigin: string;
          try { verifiedOrigin = new URL(text(args.currentUrl)).origin; } catch { throw new Error("currentUrl must be a valid HTTPS URL for handoff verification"); }
          if (verifiedOrigin !== handoff.origin) throw new Error("The verification page is outside the website origin bound to this handoff");
        }
        const session = await recordVaultSession(userId, { credentialId: saved.id, service: saved.service, accountAlias: saved.accountAlias, origin: saved.origin, workspaceId: saved.session.workspaceId, status: "authenticated", lastAuthenticatedAt: Date.now(), lastUsedAt: Date.now() });
        await updateBrowserHandoff(userId, handoffId, "completed", Date.now());
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_completed", service: saved.service, origin: saved.origin, status: "succeeded", summary: "Private browser handoff passed verification", createdAt: Date.now() });
        return { ...result, handoffId, handoffCompleted: true, session: { id: session.id, workspaceId: session.workspaceId, status: session.status, origin: session.origin } };
      }
      return result;
    }
    case "CHUCK_DAYTONA_BROWSER": {
      const action = classifyBrowserIntent({ label: typeof args.label === "string" ? args.label : String(args.action ?? "browse"), url: typeof args.url === "string" ? args.url : undefined });
      const origin = typeof args.url === "string" ? (() => { try { return new URL(args.url).origin; } catch { return undefined; } })() : undefined;
      try {
        const result = await daytonaCall(runtime, () => daytonaEngine.browser(userId, args));
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", ...(origin ? { origin } : {}), action, status: "succeeded", summary: `Browser ${String(args.action ?? "operation").replaceAll("_", " ")} completed`, createdAt: Date.now() });
        return result;
      } catch (error) {
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", ...(origin ? { origin } : {}), action, status: "failed", summary: `Browser ${String(args.action ?? "operation").replaceAll("_", " ")} failed`, createdAt: Date.now() });
        throw error;
      }
    }
    case "CHUCK_DAYTONA_BROWSER_HANDOFF": return daytonaCall(runtime, () => createBrowserHandoffRecord(userId, args));
    case "CHUCK_BROWSER_HANDOFF_STATUS": {
      const id = args.id ? text(args.id) : undefined;
      const records = id ? [await getBrowserHandoff(userId, id)] : await listBrowserHandoffs(userId, args.limit === undefined ? 10 : Number(args.limit));
      const visible = records.filter((record): record is NonNullable<typeof record> => Boolean(record)).map((record) => ({ id: record.id, workspaceId: record.workspaceId, ...(record.service ? { service: record.service } : {}), ...(record.origin ? { origin: record.origin } : {}), reason: record.reason, status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.completedAt ? { completedAt: record.completedAt } : {}) }));
      return id ? visible[0] ?? { id, status: "not_found" } : visible;
    }
    case "CHUCK_BROWSER_HANDOFF_COMPLETE": {
      const id = text(args.id);
      const handoff = await getBrowserHandoff(userId, id);
      if (!handoff) throw new Error("Browser handoff not found or not owned by you");
      if (handoff.status === "expired") throw new Error("This browser handoff has expired. Request a new private handoff.");
      if (handoff.status === "cancelled") throw new Error("This browser handoff was cancelled. Request a new private handoff.");
      if (handoff.status === "completed") return { id, status: "completed", alreadyCompleted: true };
      const updated = await updateBrowserHandoff(userId, id, "awaiting_verification");
      return { id, status: updated?.status ?? "awaiting_verification", next: "Inspect the retained browser, then call CHUCK_BROWSER_VERIFY with this handoffId and required detectors before taking any further action." };
    }
    case "CHUCK_VAULT_SAVE": return beginVaultSetup(userId, args as any);
    case "CHUCK_VAULT_LIST": return listVault(userId);
    case "CHUCK_VAULT_STATUS": return vaultStatus(userId, args.service ? text(args.service) : undefined, args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : undefined, args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined);
    case "CHUCK_VAULT_LOGIN": return daytonaCall(runtime, async () => {
      const service = normaliseVaultService(text(args.service));
      const accountAlias = args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : "default";
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const saved = (await listVault(userId)).filter((credential) => credential.service === service && credential.accountAlias === accountAlias && (!origin || credential.origin === origin));
      const loginRecipe = saved.length === 1 ? await findBrowserPlaybook(userId, saved[0]!.origin, accountAlias) : undefined;
      const login = await loginWithVault(userId, service, { workspaceId: (owner) => daytonaEngine.workspaceId(owner), login: (owner, input) => daytonaEngine.vaultLogin(owner, input) }, accountAlias, origin, loginRecipe?.login);
      if (loginRecipe) {
        const verifiedAt = login.authenticated ? Date.now() : loginRecipe.login.lastVerifiedAt;
        await saveBrowserPlaybook(userId, normalizePlaybook({ ...loginRecipe, login: { ...loginRecipe.login, ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}) }, successCount: login.authenticated ? loginRecipe.successCount + 1 : loginRecipe.successCount, failureCount: login.authenticated ? loginRecipe.failureCount : loginRecipe.failureCount + 1, lastUsedAt: Date.now() })).catch(() => undefined);
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "playbook_used", service, origin: login.origin, playbookId: loginRecipe.id, status: login.authenticated ? "succeeded" : login.needsUserInteraction ? "waiting" : "failed", summary: login.authenticated ? `Reused the verified ${service} login playbook` : `The ${service} login playbook needs review`, createdAt: Date.now() });
      }
      // A CAPTCHA, 2FA prompt, or an unfamiliar login form must not fail the
      // entire sign-in or expose credentials. Give the owner a short-lived
      // direct browser handoff and retain the same browser session instead.
      if (!login.needsUserInteraction) return login;
      return {
        ...login,
        browserHandoff: await createBrowserHandoffRecord(userId, { reason: "login", service, origin: login.origin }),
      };
    });
    case "CHUCK_VAULT_LOGOUT": return (async () => {
      const service = normaliseVaultService(text(args.service));
      const accountAlias = args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : undefined;
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const saved = (await listVault(userId)).find((credential) => credential.service === service && (!accountAlias || credential.accountAlias === accountAlias) && (!origin || credential.origin === origin));
      let browserLogout: { attempted: boolean; completed?: boolean; note?: string } = { attempted: false, note: "No site logout URL was configured." };
      if (saved?.logoutUrl) {
        try {
          await daytonaEngine.browser(userId, { action: "open", url: saved.logoutUrl });
          browserLogout = { attempted: true, completed: true };
        } catch (error) {
          browserLogout = { attempted: true, completed: false, note: error instanceof Error ? error.message : "The site logout page could not be opened." };
        }
      }
      const result = await logoutVault(userId, service, accountAlias, origin);
      let workspacePaused = false;
      try {
        await daytonaEngine.workspace(userId, "pause");
        workspacePaused = true;
      } catch { /* A missing workspace should not undo the broker revocation. */ }
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service, ...(saved?.origin ? { origin: saved.origin } : {}), status: "succeeded", summary: `Revoked the ${service}${accountAlias ? ` (${accountAlias})` : ""} browser session`, createdAt: Date.now() });
      return { ...result, browserLogout, workspacePaused, note: "The saved session is revoked. Chusky will block browser reuse in this workspace until a fresh vault login succeeds." };
    })();
    case "CHUCK_BROWSER_SESSION_REVOKE": return nativeTool(userId, "CHUCK_VAULT_LOGOUT", args, runtime);
    case "CHUCK_SHOPPING_START": return startShopping(userId, args);
    case "CHUCK_SHOPPING_LIST": return listShopping(userId, args.limit === undefined ? undefined : Number(args.limit));
    case "CHUCK_SHOPPING_SELECT_RETAILER": return selectShoppingRetailer(userId, args);
    case "CHUCK_SHOPPING_UPDATE": return updateShopping(userId, args);
    case "CHUCK_SHOPPING_CANCEL": return cancelShopping(userId, text(args.id));
    case "CHUCK_SHOPPING_PAUSE": return pauseShopping(userId, args);
    case "CHUCK_SHOPPING_RESUME": return resumeShopping(userId, text(args.id));
    case "CHUCK_SHOPPING_SAVE_SITE": return saveShoppingSitePreference(userId, args);
    case "CHUCK_SHOPPING_LIST_SITES": return listSavedShoppingSites(userId, args.limit === undefined ? undefined : Number(args.limit));
    case "CHUCK_SHOPPING_REMOVE_SITE": return removeSavedShoppingSite(userId, text(args.id));
    case "CHUCK_CREATE_PDF": return daytonaCall(runtime, () => daytonaEngine.createPdf(userId, args));
    case "CHUCK_CREATE_PRESENTATION": return daytonaCall(runtime, () => daytonaEngine.createPresentation(userId, args));
    case "CHUCK_CREATE_DOCUMENT": return daytonaCall(runtime, () => daytonaEngine.createDocument(userId, args));
    case "CHUCK_CREATE_SPREADSHEET": return daytonaCall(runtime, () => daytonaEngine.createSpreadsheet(userId, args));
    case "CHUCK_ARTIFACT": return daytonaCall(runtime, () => daytonaEngine.artifact(userId, args));
    case "CHUCK_DELEGATE_SUBAGENT":
      return runPlannedDelegation(userId, args as any, runtime);
    case "CHUCK_HANDOFF_SUBAGENT":
      return runDelegationWithDurableContinuation(userId, {
        worker: args.targetWorker as any,
        objective: text(args.objective),
        context: (args.context as any) ?? {},
        expectedOutput: args.expectedOutput ? String(args.expectedOutput) : undefined,
      }, runtime);
    case "CHUCK_PLAN_DELEGATION":
      if (runtime.worker) throw new Error("CHUCK_PLAN_DELEGATION is reserved for Chusky, the supervisor.");
      return planDelegationObjective(text(args.objective), Array.isArray(args.allowedTools) ? args.allowedTools.map((item) => String(item)) : []);
    case "CHUCK_REQUEST_ADDITIONAL_TOOLS":
      return {
        requested: true,
        intent: text(args.intent),
        reason: text(args.reason),
        preferredToolkit: args.preferredToolkit ? text(args.preferredToolkit) : undefined,
        note: "Request recorded for Chusky. It does not grant or execute any additional tool.",
      };
    case "CHUCK_RESOLVE_SUBAGENT_TOOL_REQUEST":
      return resolveSubagentToolRequest(userId, text(args.handoffId), stringList(args.allowedComposioTools, "allowedComposioTools"));
    case "CHUCK_REVIEW_SUBAGENT_ACTION":
      return reviewSubagentAction(userId, args, runtime);
    case "CHUCK_LIST_SUBAGENTS": {
      const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(50, Math.floor(Number(args.limit))));
      const records = await listHandoffRecords(userId);
      return records.slice(0, limit).map((r) => ({
        id: r.id, worker: r.to, objective: r.objective, status: r.status,
        taskId: r.taskId, timestamp: r.timestamp,
      }));
    }
    case "CHUCK_GET_SUBAGENT_STATUS": {
      const id = text(args.id);
      const records = await listHandoffRecords(userId);
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Handoff record not found or not owned by you");
      const task = record.taskId ? await getTask(userId, record.taskId) : undefined;
      return { ...record, task };
    }
    case "CHUCK_CANCEL_SUBAGENT": {
      const id = text(args.id);
      const reason = args.reason ? String(args.reason) : "Cancelled by supervisor";
      const records = await listHandoffRecords(userId);
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Handoff record not found or not owned by you");
      const updated = await requestDelegationCancellation(userId, id, reason);
      return { cancelled: true, id, worker: record.to, reason, taskId: updated?.taskId };
    }
    default: throw new Error(`Unknown native tool: ${slug}`);
  }
}
