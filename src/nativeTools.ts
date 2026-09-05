import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { enqueueTaskWorkflow, workflowFailureUrl } from "./triggerWorkflow.js";
import { resolveWorkflowEndpoint } from "./workflowUrls.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  addJob, addReminder, clearScratchpad, getJob, getReminder, listJobs, listReminders,
  readScratchpad, updateJob, updateReminder, writeScratchpad,
  forgetMemory, searchMemories, updateMemory, upsertMemory,
  blockTask, cancelTask, checkpointTask, completeTask, createTask, getTask, listTasks, retryTask, scheduleTask, setTaskWorkflowRunId,
  createAttentionRecord, getAttentionRecord, listAttentionRecords, updateAttentionRecord,
  type AttentionEntityKind,
  type TaskStatus,
  type JobRecord, type ReminderRecord,
  listFaceTimeCalls, saveImageAsset, searchImageAssets, getImageAsset, forgetImageAsset,
  listVideoJobs, listHandoffRecords, saveHandoffRecord,
} from "./store.js";
import { daytonaEngine } from "./lib/daytona/index.js";
import { startFaceTimeCallForUser } from "./calls/facetime.js";
import { startTwilioCallForUser } from "./calls/twilio.js";
import { executeDelegation } from "./subagents/executor.js";
import { enqueueSubagentToolContinuation, resolveSubagentToolRequest } from "./subagents/workflow.js";

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
  const allowed: TaskStatus[] = ["queued", "running", "blocked", "completed", "failed", "cancelled"];
  const statuses = value.map((item) => String(item));
  if (statuses.length > allowed.length || statuses.some((status) => !allowed.includes(status as TaskStatus))) throw new Error("Invalid task status filter");
  return [...new Set(statuses)] as TaskStatus[];
}

function stringList(value: unknown, label: string, maxItems = 12): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!items.length || items.length > maxItems || items.some((item) => item.length > 200)) {
    throw new Error(`${label} must contain 1-${maxItems} non-empty items of at most 200 characters`);
  }
  return items;
}

async function runDelegationWithDurableContinuation(
  userId: number,
  contract: Parameters<typeof executeDelegation>[1],
  runtime: NativeToolRuntime,
): Promise<unknown> {
  const result = await executeDelegation(userId, contract, runtime);
  if (result.status !== "requires_tool_request" || !result.handoffRecord) return result;
  const continuation = await enqueueSubagentToolContinuation(userId, result.handoffRecord.id);
  return { ...result, durableContinuation: { queued: true, ...continuation } };
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
    observation: ["source", "eventType", "summary"], open_loop: ["title"], attention_candidate: ["candidateType", "reason"],
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

function futureTimestamp(args: Record<string, unknown>): number {
  const now = Date.now();
  const delay = Number(args.delaySeconds ?? 0);
  const parsed = args.runAt ? Date.parse(String(args.runAt)) : NaN;
  const runAt = Number.isFinite(parsed) ? parsed : now + delay * 1000;
  if (!Number.isFinite(runAt) || runAt <= now) throw new Error("Reminder time must be in the future (use runAt ISO or delaySeconds)");
  if (runAt > now + 365 * 24 * 60 * 60 * 1000) throw new Error("Reminder cannot be more than one year ahead");
  return runAt;
}

export async function setReminder(userId: number, args: Record<string, unknown>): Promise<ReminderRecord> {
  const reminder: ReminderRecord = {
    id: `rem_${randomUUID()}`,
    userId,
    text: text(args.text),
    runAt: futureTimestamp(args),
    status: "scheduled",
    createdAt: Date.now(),
  };
  const client = new WorkflowClient({ token: requireQStash(), baseUrl: config.qstashUrl || undefined });
  await addReminder(userId, reminder);
  let workflow;
  try {
    workflow = await client.trigger({
    url: workflowUrl(config.reminderWorkflowUrl, "REMINDER_WORKFLOW_URL", "/workflows/reminder"),
    body: { reminderId: reminder.id, userId },
    delay: Math.max(1, Math.ceil((reminder.runAt - Date.now()) / 1000)),
    workflowRunId: reminder.id,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    });
  } catch (error) {
    await updateReminder(userId, reminder.id, { status: "failed", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  reminder.workflowRunId = workflow.workflowRunId;
  await updateReminder(userId, reminder.id, { workflowRunId: reminder.workflowRunId });
  return reminder;
}

export async function cancelReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  await updateReminder(userId, id, { status: "cancelled" });
  return `Reminder ${id} cancelled.`;
}

export async function scheduleJob(userId: number, args: Record<string, unknown>): Promise<JobRecord> {
  const cron = validateCronExpression(text(args.cron));
  const job: JobRecord = { id: `job_${randomUUID()}`, userId, text: text(args.text), cron, scheduleId: `chuck-${userId}-${randomUUID()}`, status: "active", createdAt: Date.now() };
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

export async function nativeTool(userId: number, slug: string, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<unknown> {
  switch (slug) {
    case "CHUCK_SET_REMINDER": return setReminder(userId, args);
    case "CHUCK_LIST_REMINDERS": return listReminders(userId);
    case "CHUCK_CANCEL_REMINDER": return cancelReminder(userId, text(args.id));
    case "CHUCK_SCHEDULE_JOB": return scheduleJob(userId, args);
    case "CHUCK_LIST_JOBS": return listJobs(userId);
    case "CHUCK_CANCEL_JOB": return cancelJob(userId, text(args.id));
    case "CHUCK_SCRATCHPAD_WRITE": await writeScratchpad(userId, text(args.key), text(args.content)); return { saved: true, key: args.key };
    case "CHUCK_SCRATCHPAD_READ": return readScratchpad(userId, args.query ? String(args.query) : undefined);
    case "CHUCK_SCRATCHPAD_CLEAR": await clearScratchpad(userId, args.key ? text(args.key) : undefined); return { cleared: true };
    case "CHUCK_SAVE_MEMORY": return upsertMemory(userId, { category: (args.category as any) ?? "fact", key: text(args.key), value: text(args.value), source: args.source ? text(args.source) : undefined, confidence: Number(args.confidence ?? 1), sensitivity: args.sensitivity === "sensitive" ? "sensitive" : "normal", projectId: args.projectId ? text(args.projectId) : undefined, personKey: args.personKey ? text(args.personKey) : undefined, reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt), expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt) });
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
    case "CHUCK_START_FACETIME_CALL": return startFaceTimeCallForUser(userId, { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose) });
    case "CHUCK_LIST_FACETIME_CALLS": return listFaceTimeCalls(userId);
    case "CHUCK_START_PHONE_CALL": return startTwilioCallForUser(userId, { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose) });
    case "CHUCK_LIST_PHONE_CALLS": return (await listFaceTimeCalls(userId)).filter((call) => call.provider === "twilio");
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
    case "CHUCK_DAYTONA_WORKSPACE": return daytonaEngine.workspace(userId, (args.action as "get" | "create" | "status" | "pause" | "archive") ?? "status");
    case "CHUCK_DAYTONA_EXECUTE": return daytonaEngine.execute(userId, daytonaCommand(args.command), args.cwd ? text(args.cwd) : undefined, args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds));
    case "CHUCK_DAYTONA_LIST_FILES": return daytonaEngine.listFiles(userId, args.path ? text(args.path) : undefined, args.depth === undefined ? undefined : Number(args.depth));
    case "CHUCK_DAYTONA_READ_FILE": return daytonaEngine.readFile(userId, text(args.path), args.maxChars === undefined ? undefined : Number(args.maxChars));
    case "CHUCK_DAYTONA_WRITE_FILE": return daytonaEngine.writeFile(userId, text(args.path), fileContent(args.content));
    case "CHUCK_DAYTONA_FIND_FILES": return daytonaEngine.findFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern));
    case "CHUCK_DAYTONA_SEARCH_FILES": return daytonaEngine.searchFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern));
    case "CHUCK_DAYTONA_FILE_DETAILS": return daytonaEngine.fileDetails(userId, text(args.path));
    case "CHUCK_DAYTONA_CREATE_FOLDER": return daytonaEngine.createFolder(userId, text(args.path));
    case "CHUCK_DAYTONA_MOVE_FILES": return daytonaEngine.moveFiles(userId, text(args.source), text(args.destination));
    case "CHUCK_DAYTONA_DELETE_FILE": return daytonaEngine.deleteFile(userId, text(args.path), args.recursive === true);
    case "CHUCK_DAYTONA_DELETE_WORKSPACE": return daytonaEngine.deleteWorkspace(userId);
    case "CHUCK_DAYTONA_PREVIEW": return daytonaEngine.preview(userId, Number(args.port));
    case "CHUCK_DAYTONA_CREATE_SNAPSHOT": return daytonaEngine.createSnapshot(userId, text(args.name));
    case "CHUCK_DAYTONA_COMPUTER": return daytonaEngine.computer(userId, args);
    case "CHUCK_DAYTONA_PAUSE": return daytonaEngine.pause(userId);
    case "CHUCK_DAYTONA_PTY": return daytonaEngine.pty(userId, args);
    case "CHUCK_DAYTONA_GIT": return daytonaEngine.git(userId, args);
    case "CHUCK_DAYTONA_BROWSER": return daytonaEngine.browser(userId, args);
    case "CHUCK_CREATE_PDF": return daytonaEngine.createPdf(userId, args);
    case "CHUCK_CREATE_PRESENTATION": return daytonaEngine.createPresentation(userId, args);
    case "CHUCK_ARTIFACT": return daytonaEngine.artifact(userId, args);
    case "CHUCK_DELEGATE_SUBAGENT":
      return runDelegationWithDurableContinuation(userId, args as any, runtime);
    case "CHUCK_HANDOFF_SUBAGENT":
      return runDelegationWithDurableContinuation(userId, {
        worker: args.targetWorker as any,
        objective: text(args.objective),
        context: (args.context as any) ?? {},
        expectedOutput: args.expectedOutput ? String(args.expectedOutput) : undefined,
      }, runtime);
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
      if (record.taskId) await cancelTask(userId, record.taskId);
      const updated = { ...record, status: "cancelled" as const };
      await saveHandoffRecord(userId, updated);
      return { cancelled: true, id, worker: record.to, reason, taskId: record.taskId };
    }
    default: throw new Error(`Unknown native tool: ${slug}`);
  }
}
