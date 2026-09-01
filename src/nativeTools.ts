import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { enqueueTaskWorkflow, workflowFailureUrl } from "./triggerWorkflow.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  addJob, addReminder, clearScratchpad, getJob, getReminder, listJobs, listReminders,
  readScratchpad, updateJob, updateReminder, writeScratchpad,
  forgetMemory, searchMemories, upsertMemory,
  blockTask, cancelTask, checkpointTask, completeTask, createTask, getTask, listTasks, retryTask, scheduleTask, setTaskWorkflowRunId,
  createAttentionRecord, getAttentionRecord, listAttentionRecords, updateAttentionRecord,
  type AttentionEntityKind,
  type TaskStatus,
  type JobRecord, type ReminderRecord,
  listFaceTimeCalls,
} from "./store.js";
import { daytonaEngine } from "./lib/daytona/index.js";
import { startFaceTimeCallForUser } from "./calls/facetime.js";
import { startTwilioCallForUser } from "./calls/twilio.js";

const MAX_TEXT = 1000;

function text(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > MAX_TEXT) throw new Error(`Text must be 1-${MAX_TEXT} characters`);
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

function requireUrl(url: string, label: string): string {
  if (!url) throw new Error(`${label} is not configured`);
  if (!/^https:\/\//i.test(url)) throw new Error(`${label} must be an HTTPS URL`);
  return url;
}

export function workflowUrl(configured: string, label: string, path: string): string {
  return requireUrl(configured || (config.webhookUrl ? `${config.webhookUrl.replace(/\/+$/, "")}${path}` : ""), label);
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

export async function nativeTool(userId: number, slug: string, args: Record<string, unknown>): Promise<unknown> {
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
    case "CHUCK_SAVE_MEMORY": return upsertMemory(userId, { category: (args.category as any) ?? "fact", key: text(args.key), value: text(args.value), confidence: Number(args.confidence ?? 1) });
    case "CHUCK_SEARCH_MEMORY": return searchMemories(userId, args.query ? String(args.query) : undefined);
    case "CHUCK_FORGET_MEMORY": return { forgotten: await forgetMemory(userId, text(args.key)) };
    case "CHUCK_ATTENTION_STATE": return attentionTool(userId, args);
    case "CHUCK_START_FACETIME_CALL": return startFaceTimeCallForUser(userId, { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose) });
    case "CHUCK_LIST_FACETIME_CALLS": return listFaceTimeCalls(userId);
    case "CHUCK_START_PHONE_CALL": return startTwilioCallForUser(userId, { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose) });
    case "CHUCK_LIST_PHONE_CALLS": return (await listFaceTimeCalls(userId)).filter((call) => call.provider === "twilio");
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
    case "CHUCK_DAYTONA_EXECUTE": return daytonaEngine.execute(userId, text(args.command), args.cwd ? text(args.cwd) : undefined, args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds));
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
    case "CHUCK_ARTIFACT": return daytonaEngine.artifact(userId, args);
    default: throw new Error(`Unknown native tool: ${slug}`);
  }
}
