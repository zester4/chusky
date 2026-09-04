import test from "node:test";
import assert from "node:assert/strict";
import { deliverJob, deliverReminder, parseJobWorkflowPayload, parseReminderWorkflowPayload } from "../src/workflows.js";
import type { JobRecord, ReminderRecord } from "../src/store.js";
import { resolveWorkflowEndpoint } from "../src/workflowUrls.js";

function deps(overrides: Partial<Parameters<typeof deliverReminder>[1]> = {}) {
  const sent: { chatId: number; text: string }[] = [];
  const updates: Partial<ReminderRecord>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];
  const claims = new Set<string>();
  const reminder: ReminderRecord = { id: "rem-1", userId: 1, text: "A <danger> & check", runAt: Date.now(), status: "scheduled", createdAt: Date.now() };
  const job: JobRecord = { id: "job-1", userId: 1, text: "Run <task>", cron: "* * * * *", scheduleId: "schedule-1", status: "active", createdAt: Date.now() };
  const base = {
    getReminder: async () => reminder,
    updateReminder: async (_userId: number, _id: string, patch: Partial<ReminderRecord>) => { updates.push(patch); return true; },
    getJob: async () => job,
    updateJob: async (_userId: number, _id: string, patch: Record<string, unknown>) => { jobUpdates.push(patch); return true; },
    getTelegramChatId: async () => 99,
    sendMessage: async (chatId: number, text: string) => { sent.push({ chatId, text }); },
    claimDelivery: async (key: string) => { if (claims.has(key)) return false; claims.add(key); return true; },
    completeDelivery: async () => undefined,
  };
  return { ...base, ...overrides, sent, updates, jobUpdates, reminder, job };
}

test("workflow endpoints always use the configured public HTTPS URL", () => {
  assert.equal(resolveWorkflowEndpoint("", "https://chusky.example", "/workflows/job", "Job workflows"), "https://chusky.example/workflows/job");
  assert.equal(resolveWorkflowEndpoint("https://jobs.example/workflows/job", "https://chusky.example", "/workflows/job", "Job workflows"), "https://jobs.example/workflows/job");
  assert.throws(() => resolveWorkflowEndpoint("http://chusky.example/workflows/job", "https://chusky.example", "/workflows/job", "Job workflows"), /HTTPS URL/);
});

test("reminder delivery is idempotent for cancelled or already-sent records", async () => {
  const state = deps({ getReminder: async () => ({ ...deps().reminder, status: "cancelled" }) });
  const result = await deliverReminder({ reminderId: "rem-1", userId: 1 }, state);
  assert.deepEqual(result, { skipped: true, delivered: false });
  assert.equal(state.sent.length, 0);
});

test("reminder delivery escapes Telegram HTML and marks sent after delivery", async () => {
  const state = deps();
  const result = await deliverReminder({ reminderId: "rem-1", userId: 1 }, state);
  assert.deepEqual(result, { delivered: true });
  assert.match(state.sent[0].text, /A &lt;danger&gt; &amp; check/);
  assert.deepEqual(state.updates, [{ status: "sent" }]);
});

test("reminders without a Telegram mapping fail without attempting delivery", async () => {
  const state = deps({ getTelegramChatId: async () => undefined });
  const result = await deliverReminder({ reminderId: "rem-1", userId: 1 }, state);
  assert.deepEqual(result, { delivered: false });
  assert.deepEqual(state.updates, [{ status: "failed", deliveryError: "No Telegram mapping" }]);
  assert.equal(state.sent.length, 0);
});

test("recurring job delivery skips cancelled jobs and does not mutate active jobs", async () => {
  const state = deps({ getJob: async () => ({ ...deps().job, status: "cancelled" }) });
  const result = await deliverJob({ jobId: "job-1", userId: 1 }, state);
  assert.deepEqual(result, { skipped: true, delivered: false });
  assert.equal(state.sent.length, 0);
});

test("recurring job delivery escapes content and sends only to the mapped owner", async () => {
  const state = deps();
  const result = await deliverJob({ jobId: "job-1", userId: 1 }, state);
  assert.deepEqual(result, { delivered: true });
  assert.equal(state.sent[0].chatId, 99);
  assert.match(state.sent[0].text, /Run &lt;task&gt;/);
});

test("recurring job delivery runs the agent before sending its response", async () => {
  const state = deps({ runAgent: async (job) => ({ text: `Agent result for ${job.id}` }) });
  const result = await deliverJob({ jobId: "job-1", userId: 1, occurrenceId: "occ-agent" }, state);
  assert.deepEqual(result, { delivered: true });
  assert.match(state.sent[0].text, /Agent result for job-1/);
  assert.doesNotMatch(state.sent[0].text, /Run &lt;task&gt;/);
});

test("recurring jobs do not deliver without a Telegram mapping", async () => {
  const state = deps({ getTelegramChatId: async () => undefined });
  const result = await deliverJob({ jobId: "job-1", userId: 1 }, state);
  assert.deepEqual(result, { delivered: false });
  assert.equal(state.sent.length, 0);
});

test("delivery claims suppress duplicate reminder and job executions", async () => {
  const state = deps();
  assert.deepEqual(await deliverReminder({ reminderId: "rem-1", userId: 1 }, state), { delivered: true });
  assert.deepEqual(await deliverReminder({ reminderId: "rem-1", userId: 1 }, state), { skipped: true, delivered: false });
  assert.deepEqual(await deliverJob({ jobId: "job-1", userId: 1, occurrenceId: "occ-1" }, state), { delivered: true });
  assert.deepEqual(await deliverJob({ jobId: "job-1", userId: 1, occurrenceId: "occ-1" }, state), { skipped: true, delivered: false });
  assert.equal(state.sent.length, 2);
});

test("workflow payload validation rejects malformed and cross-tenant payloads", () => {
  assert.deepEqual(parseReminderWorkflowPayload({ reminderId: "rem_abc", userId: 7 }), { reminderId: "rem_abc", userId: 7 });
  assert.deepEqual(parseJobWorkflowPayload({ jobId: "job_abc", userId: 7, occurrenceId: "run-1" }), { jobId: "job_abc", userId: 7, occurrenceId: "run-1" });
  assert.throws(() => parseReminderWorkflowPayload({ reminderId: "rem_abc", userId: 0 }));
  assert.throws(() => parseJobWorkflowPayload({ jobId: "other", userId: 7 }));
});
