import test from "node:test";
import assert from "node:assert/strict";
import { deliverJob, deliverReminder } from "../src/workflows.js";
import type { JobRecord, ReminderRecord } from "../src/store.js";

function deps(overrides: Partial<Parameters<typeof deliverReminder>[1]> = {}) {
  const sent: { chatId: number; text: string }[] = [];
  const updates: Partial<ReminderRecord>[] = [];
  const reminder: ReminderRecord = { id: "rem-1", userId: 1, text: "A <danger> & check", runAt: Date.now(), status: "scheduled", createdAt: Date.now() };
  const job: JobRecord = { id: "job-1", userId: 1, text: "Run <task>", cron: "* * * * *", scheduleId: "schedule-1", status: "active", createdAt: Date.now() };
  const base = {
    getReminder: async () => reminder,
    updateReminder: async (_userId: number, _id: string, patch: Partial<ReminderRecord>) => { updates.push(patch); return true; },
    getJob: async () => job,
    getTelegramChatId: async () => 99,
    sendMessage: async (chatId: number, text: string) => { sent.push({ chatId, text }); },
  };
  return { ...base, ...overrides, sent, updates, reminder, job };
}

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
  assert.deepEqual(state.updates, [{ status: "failed" }]);
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

test("recurring jobs do not deliver without a Telegram mapping", async () => {
  const state = deps({ getTelegramChatId: async () => undefined });
  const result = await deliverJob({ jobId: "job-1", userId: 1 }, state);
  assert.deepEqual(result, { delivered: false });
  assert.equal(state.sent.length, 0);
});
