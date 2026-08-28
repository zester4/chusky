import type { JobRecord, ReminderRecord } from "./store.js";

export interface ReminderWorkflowPayload { reminderId: string; userId: number; }
export interface JobWorkflowPayload { jobId: string; userId: number; }

export interface WorkflowDependencies {
  getReminder(userId: number, id: string): Promise<ReminderRecord | undefined>;
  updateReminder(userId: number, id: string, patch: Partial<ReminderRecord>): Promise<boolean>;
  getJob(userId: number, id: string): Promise<JobRecord | undefined>;
  getTelegramChatId(userId: number): Promise<number | undefined>;
  sendMessage(chatId: number, text: string, options: { parse_mode: "HTML" }): Promise<unknown>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function deliverReminder(payload: ReminderWorkflowPayload, deps: WorkflowDependencies): Promise<{ skipped?: boolean; delivered: boolean }> {
  const reminder = await deps.getReminder(payload.userId, payload.reminderId);
  if (!reminder || reminder.status !== "scheduled") return { skipped: true, delivered: false };
  const chatId = await deps.getTelegramChatId(payload.userId);
  if (!chatId) {
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "failed" });
    return { delivered: false };
  }
  await deps.sendMessage(chatId, `⏰ <b>Chusky reminder</b>\n\n${escapeHtml(reminder.text)}`, { parse_mode: "HTML" });
  await deps.updateReminder(payload.userId, payload.reminderId, { status: "sent" });
  return { delivered: true };
}

export async function deliverJob(payload: JobWorkflowPayload, deps: WorkflowDependencies): Promise<{ skipped?: boolean; delivered: boolean }> {
  const job = await deps.getJob(payload.userId, payload.jobId);
  if (!job || job.status !== "active") return { skipped: true, delivered: false };
  const chatId = await deps.getTelegramChatId(payload.userId);
  if (!chatId) return { delivered: false };
  await deps.sendMessage(chatId, `🔁 <b>Chusky scheduled job</b>\n\n${escapeHtml(job.text)}`, { parse_mode: "HTML" });
  return { delivered: true };
}
