import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  addJob, addReminder, clearScratchpad, getJob, getReminder, listJobs, listReminders,
  readScratchpad, updateJob, updateReminder, writeScratchpad,
  forgetMemory, searchMemories, upsertMemory,
  type JobRecord, type ReminderRecord,
} from "./store.js";

const MAX_TEXT = 1000;

function text(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > MAX_TEXT) throw new Error(`Text must be 1-${MAX_TEXT} characters`);
  return result;
}

function requireUrl(url: string, label: string): string {
  if (!url) throw new Error(`${label} is not configured`);
  return url;
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
  const client = new WorkflowClient({ token: requireQStash() });
  const workflow = await client.trigger({
    url: requireUrl(config.reminderWorkflowUrl, "REMINDER_WORKFLOW_URL"),
    body: { reminderId: reminder.id, userId },
    delay: Math.max(1, Math.ceil((reminder.runAt - Date.now()) / 1000)),
    workflowRunId: reminder.id,
    retries: 3,
  });
  reminder.workflowRunId = workflow.workflowRunId;
  await addReminder(userId, reminder);
  return reminder;
}

export async function cancelReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  await updateReminder(userId, id, { status: "cancelled" });
  return `Reminder ${id} cancelled.`;
}

export async function scheduleJob(userId: number, args: Record<string, unknown>): Promise<JobRecord> {
  const cron = text(args.cron);
  if (cron.split(/\s+/).length < 5) throw new Error("cron must be a valid 5-field CRON expression");
  const job: JobRecord = { id: `job_${randomUUID()}`, userId, text: text(args.text), cron, scheduleId: `chuck-${userId}-${randomUUID()}`, status: "active", createdAt: Date.now() };
  const client = new QStashClient({ token: requireQStash() });
  await client.schedules.create({
    scheduleId: job.scheduleId,
    destination: requireUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL"),
    body: JSON.stringify({ jobId: job.id, userId }),
    headers: { "Content-Type": "application/json" },
    cron,
    retries: 3,
  });
  await addJob(userId, job);
  return job;
}

export async function cancelJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  const client = new QStashClient({ token: requireQStash() });
  await client.schedules.delete(job.scheduleId);
  await updateJob(userId, id, { status: "cancelled" });
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
    default: throw new Error(`Unknown native tool: ${slug}`);
  }
}
