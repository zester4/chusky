import type { JobRecord, ReminderRecord } from "./store.js";
import { mdToTelegramHtml, splitHtml } from "./markdown.js";

export interface ReminderWorkflowPayload { reminderId: string; userId: number; }
export interface JobWorkflowPayload { jobId: string; userId: number; occurrenceId?: string; }

export interface WorkflowDependencies {
  getReminder(userId: number, id: string): Promise<ReminderRecord | undefined>;
  updateReminder(userId: number, id: string, patch: Partial<ReminderRecord>): Promise<boolean>;
  getJob(userId: number, id: string): Promise<JobRecord | undefined>;
  updateJob(userId: number, id: string, patch: Partial<JobRecord>): Promise<boolean>;
  getTelegramChatId(userId: number): Promise<number | undefined>;
  sendMessage(chatId: number, text: string, options: { parse_mode: "HTML" }): Promise<unknown>;
  runAgent?(job: JobRecord): Promise<{ text: string; cost?: number }>;
  runWorker?(job: JobRecord): Promise<{ text: string; cost?: number }>;
  claimDelivery?(key: string, leaseMs: number): Promise<boolean>;
  completeDelivery?(key: string, ttlSeconds: number): Promise<void>;
}

export function parseReminderWorkflowPayload(value: unknown): ReminderWorkflowPayload {
  if (!value || typeof value !== "object") throw new Error("Workflow payload must be an object");
  const payload = value as Record<string, unknown>;
  if (typeof payload.reminderId !== "string" || !/^rem_[\w-]+$/.test(payload.reminderId)) throw new Error("Invalid reminderId");
  if (!Number.isSafeInteger(payload.userId) || Number(payload.userId) < 1) throw new Error("Invalid userId");
  return { reminderId: payload.reminderId, userId: Number(payload.userId) };
}

export function parseJobWorkflowPayload(value: unknown): JobWorkflowPayload {
  if (!value || typeof value !== "object") throw new Error("Workflow payload must be an object");
  const payload = value as Record<string, unknown>;
  if (typeof payload.jobId !== "string" || !/^job_[\w-]+$/.test(payload.jobId)) throw new Error("Invalid jobId");
  if (!Number.isSafeInteger(payload.userId) || Number(payload.userId) < 1) throw new Error("Invalid userId");
  return { jobId: payload.jobId, userId: Number(payload.userId), ...(typeof payload.occurrenceId === "string" ? { occurrenceId: payload.occurrenceId } : {}) };
}

export async function deliverReminder(payload: ReminderWorkflowPayload, deps: WorkflowDependencies): Promise<{ skipped?: boolean; delivered: boolean }> {
  const reminder = await deps.getReminder(payload.userId, payload.reminderId);
  if (!reminder || reminder.status !== "scheduled") return { skipped: true, delivered: false };
  const deliveryKey = `reminder:${payload.reminderId}`;
  if (deps.claimDelivery && !(await deps.claimDelivery(deliveryKey, 15 * 60 * 1000))) return { skipped: true, delivered: false };
  const chatId = await deps.getTelegramChatId(payload.userId);
  if (!chatId) {
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "failed", deliveryError: "No Telegram mapping" });
    return { delivered: false };
  }
  try {
    await deps.sendMessage(chatId, `⏰ <b>Chusky reminder</b>\n\n${mdToTelegramHtml(reminder.text)}`, { parse_mode: "HTML" });
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "sent" });
    if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 7 * 24 * 60 * 60);
  } catch (error) {
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "failed", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return { delivered: true };
}

export async function deliverJob(payload: JobWorkflowPayload, deps: WorkflowDependencies): Promise<{ skipped?: boolean; delivered: boolean }> {
  const job = await deps.getJob(payload.userId, payload.jobId);
  if (!job || job.status !== "active") return { skipped: true, delivered: false };
  const deliveryKey = `job:${payload.jobId}:${payload.occurrenceId ?? "legacy"}`;
  if (deps.claimDelivery && !(await deps.claimDelivery(deliveryKey, 15 * 60 * 1000))) return { skipped: true, delivered: false };
  const chatId = await deps.getTelegramChatId(payload.userId);
  if (!chatId) {
    await deps.updateJob(payload.userId, payload.jobId, { deliveryError: "No Telegram mapping" });
    return { delivered: false };
  }
  try {
    const result = job.workerBinding && deps.runWorker
      ? await deps.runWorker(job)
      : deps.runAgent
        ? await deps.runAgent(job)
        : { text: job.text };
    const response = result.text.trim() || "Scheduled job completed.";
    const header = "🔁 <b>Chusky scheduled job</b>\n\n";
    for (const chunk of splitHtml(mdToTelegramHtml(response), 3900)) {
      await deps.sendMessage(chatId, `${header}${chunk}`, { parse_mode: "HTML" });
    }
    if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 7 * 24 * 60 * 60);
  } catch (error) {
    await deps.updateJob(payload.userId, payload.jobId, { deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return { delivered: true };
}
