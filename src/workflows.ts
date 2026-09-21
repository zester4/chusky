import type { JobRecord, ReminderRecord, ReminderDeliveryTarget } from "./store.js";
import { mdToTelegramHtml, splitHtml } from "./markdown.js";
import { posthog } from "./posthog.js";
import type { AutonomyExecutionStatus, AutonomyMode, JobOccurrenceRecord } from "./autonomy/types.js";

export interface ReminderWorkflowPayload { reminderId: string; userId: number; approvalId?: string; attemptId?: string; }
export interface JobWorkflowPayload { jobId: string; userId: number; occurrenceId?: string; approvalId?: string; }

export interface WorkflowDependencies {
  getReminder(userId: number, id: string): Promise<ReminderRecord | undefined>;
  updateReminder(userId: number, id: string, patch: Partial<ReminderRecord>): Promise<boolean>;
  getJob(userId: number, id: string): Promise<JobRecord | undefined>;
  updateJob(userId: number, id: string, patch: Partial<JobRecord>): Promise<boolean>;
  getTelegramChatId(userId: number): Promise<number | undefined>;
  sendMessage(chatId: number, text: string, options: { parse_mode: "HTML" }): Promise<unknown>;
  sendChannelMessage?(target: ReminderDeliveryTarget, text: string, idempotencyKey: string): Promise<unknown>;
  rescheduleReminder?(reminder: ReminderRecord, runAt: number): Promise<void>;
  runReminder?(reminder: ReminderRecord): Promise<WorkflowExecutionResult>;
  runAgent?(job: JobRecord): Promise<WorkflowExecutionResult>;
  runWorker?(job: JobRecord): Promise<WorkflowExecutionResult>;
  getJobOccurrence?(userId: number, jobId: string, occurrenceId: string): Promise<JobOccurrenceRecord | undefined>;
  createJobOccurrence?(record: JobOccurrenceRecord): Promise<JobOccurrenceRecord>;
  updateJobOccurrence?(userId: number, id: string, patch: Partial<JobOccurrenceRecord>, expectedVersion?: number): Promise<JobOccurrenceRecord | undefined>;
  claimDelivery?(key: string, leaseMs: number): Promise<boolean>;
  completeDelivery?(key: string, ttlSeconds: number): Promise<void>;
}

export interface WorkflowExecutionResult {
  text: string;
  cost?: number;
  toolCalls?: number;
  suppressDelivery?: boolean;
  status?: AutonomyExecutionStatus;
  nextAction?: string;
  waitReason?: string;
  retryAt?: number;
}

export function parseReminderWorkflowPayload(value: unknown): ReminderWorkflowPayload {
  if (!value || typeof value !== "object") throw new Error("Workflow payload must be an object");
  const payload = value as Record<string, unknown>;
  if (typeof payload.reminderId !== "string" || !/^rem_[\w-]+$/.test(payload.reminderId)) throw new Error("Invalid reminderId");
  if (!Number.isSafeInteger(payload.userId) || Number(payload.userId) < 1) throw new Error("Invalid userId");
  if (payload.approvalId !== undefined && (typeof payload.approvalId !== "string" || !/^appr_[A-Za-z0-9_-]{1,160}$/.test(payload.approvalId))) throw new Error("Invalid approvalId");
  if (payload.attemptId !== undefined && (typeof payload.attemptId !== "string" || !/^[A-Za-z0-9_.-]{1,160}$/.test(payload.attemptId))) throw new Error("Invalid attemptId");
  return { reminderId: payload.reminderId, userId: Number(payload.userId), ...(payload.approvalId ? { approvalId: payload.approvalId } : {}), ...(payload.attemptId ? { attemptId: payload.attemptId } : {}) };
}

export function parseJobWorkflowPayload(value: unknown): JobWorkflowPayload {
  if (!value || typeof value !== "object") throw new Error("Workflow payload must be an object");
  const payload = value as Record<string, unknown>;
  if (typeof payload.jobId !== "string" || !/^job_[\w-]+$/.test(payload.jobId)) throw new Error("Invalid jobId");
  if (!Number.isSafeInteger(payload.userId) || Number(payload.userId) < 1) throw new Error("Invalid userId");
  if (payload.approvalId !== undefined && (typeof payload.approvalId !== "string" || !/^appr_[A-Za-z0-9_-]{1,160}$/.test(payload.approvalId))) throw new Error("Invalid approvalId");
  return { jobId: payload.jobId, userId: Number(payload.userId), ...(typeof payload.occurrenceId === "string" ? { occurrenceId: payload.occurrenceId } : {}), ...(payload.approvalId ? { approvalId: payload.approvalId } : {}) };
}

export async function deliverReminder(payload: ReminderWorkflowPayload, deps: WorkflowDependencies): Promise<{ skipped?: boolean; delivered: boolean }> {
  const reminder = await deps.getReminder(payload.userId, payload.reminderId);
  if (!reminder || (reminder.status !== "scheduled" && !(payload.approvalId && reminder.status === "waiting"))) return { skipped: true, delivered: false };
  // Each wait_until poll is a distinct execution attempt. Keeping the attempt
  // in the key prevents the first completed poll from suppressing every later
  // wake-up for the same reminder.
  const deliveryKey = `reminder:${payload.reminderId}:${payload.attemptId ?? "initial"}${payload.approvalId ? `:approval:${payload.approvalId}` : ""}`;
  if (deps.claimDelivery && !(await deps.claimDelivery(deliveryKey, 15 * 60 * 1000))) return { skipped: true, delivered: false };
  const target = reminder.deliveryTarget;
  const chatId = target?.provider === "telegram" ? Number(target.conversationId) : await deps.getTelegramChatId(payload.userId);
  if ((!target && !chatId) || (target?.provider === "telegram" && !Number.isSafeInteger(chatId)) || (target && target.provider !== "telegram" && !deps.sendChannelMessage)) {
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "failed", deliveryError: "No Telegram mapping" });
    return { delivered: false };
  }
  try {
    const result = reminder.mode && reminder.mode !== "notify" && deps.runReminder
      ? await deps.runReminder(reminder)
      : { text: reminder.text };
    if (result.status === "waiting" || result.status === "blocked") {
      const retryAt = result.retryAt ?? (reminder.mode === "wait_until" && reminder.pollEverySeconds ? Date.now() + reminder.pollEverySeconds * 1000 : undefined);
      if (retryAt && retryAt > Date.now() && deps.rescheduleReminder) await deps.rescheduleReminder(reminder, retryAt);
      else await deps.updateReminder(payload.userId, payload.reminderId, { status: "waiting", nextAction: result.nextAction ?? reminder.nextAction, deliveryError: result.waitReason });
      if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 24 * 60 * 60);
      return { skipped: true, delivered: false };
    }
    if (result.suppressDelivery) {
      await deps.updateReminder(payload.userId, payload.reminderId, { status: "sent", deliveryError: undefined });
      if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 7 * 24 * 60 * 60);
      return { skipped: true, delivered: false };
    }
    const response = result.text.trim() || "Reminder check-in completed.";
    if (target && target.provider !== "telegram") {
      await deps.sendChannelMessage!(target, `⏰ Chusky reminder\n\n${response}`, `reminder:${payload.reminderId}`);
    } else {
      if (!chatId) throw new Error("No Telegram mapping");
      await deps.sendMessage(chatId, `⏰ <b>Chusky reminder</b>\n\n${mdToTelegramHtml(response)}`, { parse_mode: "HTML" });
    }
    await deps.updateReminder(payload.userId, payload.reminderId, { status: "sent" });
    posthog?.capture({ distinctId: String(payload.userId), event: "reminder_delivered", properties: { reminder_id: payload.reminderId } });
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
  const deliveryKey = `job:${payload.jobId}:${payload.occurrenceId ?? "legacy"}${payload.approvalId ? `:approval:${payload.approvalId}` : ""}`;
  if (deps.claimDelivery && !(await deps.claimDelivery(deliveryKey, 15 * 60 * 1000))) return { skipped: true, delivered: false };
  const occurrenceId = payload.occurrenceId ?? "legacy";
  let occurrence: JobOccurrenceRecord | undefined;
  if (deps.getJobOccurrence && deps.createJobOccurrence && deps.updateJobOccurrence) {
    occurrence = await deps.getJobOccurrence(payload.userId, payload.jobId, occurrenceId);
    if (occurrence && ["completed", "cancelled"].includes(occurrence.status)) return { skipped: true, delivered: false };
    if (!occurrence) {
      const now = Date.now();
      occurrence = await deps.createJobOccurrence({
        id: `occ_${payload.jobId}_${occurrenceId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 240),
        userId: payload.userId, jobId: payload.jobId, occurrenceId, status: "running", mode: job.mode ?? (job.workerBinding ? "act" : "notify"),
        idempotencyKey: deliveryKey, ...(job.contextSnapshot ? { context: job.contextSnapshot } : {}), startedAt: now, createdAt: now, updatedAt: now, version: 0,
      });
    } else if (occurrence.status !== "running") {
      occurrence = await deps.updateJobOccurrence(payload.userId, occurrence.id, { status: "running", startedAt: occurrence.startedAt ?? Date.now(), error: undefined }, occurrence.version);
    }
  }
  const target = job.deliveryTarget;
  const chatId = target?.provider === "telegram" ? Number(target.conversationId) : (!target ? await deps.getTelegramChatId(payload.userId) : undefined);
  if ((!target && !chatId) || (target?.provider === "telegram" && !Number.isSafeInteger(chatId)) || (target && target.provider !== "telegram" && !deps.sendChannelMessage)) {
    if (occurrence && deps.updateJobOccurrence) await deps.updateJobOccurrence(payload.userId, occurrence.id, { status: "failed", error: target ? `No adapter for ${target.provider}` : "No Telegram mapping", completedAt: Date.now() }, occurrence.version);
    await deps.updateJob(payload.userId, payload.jobId, { deliveryError: target ? `No adapter for ${target.provider}` : "No Telegram mapping" });
    return { delivered: false };
  }
  try {
    const result = job.mode === "notify"
      ? { text: job.text }
      : job.workerBinding && deps.runWorker
      ? await deps.runWorker(job)
        : deps.runAgent
        ? await deps.runAgent(job)
        : { text: job.text };
    if (occurrence && deps.updateJobOccurrence) {
      occurrence = await deps.updateJobOccurrence(payload.userId, occurrence.id, {
        status: result.status === "waiting" || result.status === "blocked" ? result.status : "running",
        result: result.text, nextAction: result.nextAction, waitReason: result.waitReason, cost: result.cost, toolCalls: result.toolCalls,
        completedAt: result.status === "waiting" || result.status === "blocked" ? undefined : undefined,
      }, occurrence.version) ?? occurrence;
    }
    if (result.status === "waiting" || result.status === "blocked") {
      if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 24 * 60 * 60);
      return { skipped: true, delivered: false };
    }
    if (result.suppressDelivery) {
      if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 7 * 24 * 60 * 60);
      if (occurrence && deps.updateJobOccurrence) await deps.updateJobOccurrence(payload.userId, occurrence.id, { status: "completed", completedAt: Date.now() }, occurrence.version);
      return { skipped: true, delivered: false };
    }
    const response = result.text.trim() || "Scheduled job completed.";
    if (target && target.provider !== "telegram") {
      const title = job.kind === "attention_pulse" ? "🧭 Chusky attention pulse" : "🔁 Chusky scheduled job";
      await deps.sendChannelMessage!(target, `${title}\n\n${response}`, `job:${payload.jobId}:${payload.occurrenceId ?? "legacy"}`);
    } else {
      const header = job.kind === "attention_pulse" ? "🧭 <b>Chusky attention pulse</b>\n\n" : "🔁 <b>Chusky scheduled job</b>\n\n";
      for (const chunk of splitHtml(mdToTelegramHtml(response), 3900)) {
        await deps.sendMessage(chatId!, `${header}${chunk}`, { parse_mode: "HTML" });
      }
    }
    if (occurrence && deps.updateJobOccurrence) await deps.updateJobOccurrence(payload.userId, occurrence.id, { status: "completed", completedAt: Date.now() }, occurrence.version);
    if (deps.completeDelivery) await deps.completeDelivery(deliveryKey, 7 * 24 * 60 * 60);
  } catch (error) {
    if (occurrence && deps.updateJobOccurrence) await deps.updateJobOccurrence(payload.userId, occurrence.id, { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), completedAt: Date.now() }, occurrence.version);
    await deps.updateJob(payload.userId, payload.jobId, { deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return { delivered: true };
}
