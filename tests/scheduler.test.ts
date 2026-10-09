import test from "node:test";
import assert from "node:assert/strict";
import { reconcileUserSchedules } from "../src/scheduler.js";
import type { JobRecord } from "../src/store.js";

const job = (status: JobRecord["status"], scheduleId: string): JobRecord => ({ id: `job_${scheduleId}`, userId: 1, text: "check", cron: "0 9 * * 1", scheduleId, status, createdAt: Date.now() });

test("schedule reconciliation recreates drift and removes cancelled schedules", async () => {
  const active = job("active", "schedule-missing");
  const changed = { ...job("active", "schedule-changed"), cron: "0 10 * * 1" };
  const cancelled = job("cancelled", "schedule-cancelled");
  const recreated: string[] = [];
  const removed: string[] = [];
  const result = await reconcileUserSchedules(1, {
    jobs: async () => [active, changed, cancelled],
    schedules: async () => [
      { scheduleId: changed.scheduleId, cron: "0 9 * * 1", destination: "https://example.test/workflows/job" },
      { scheduleId: cancelled.scheduleId, cron: cancelled.cron, destination: "https://example.test/workflows/job" },
    ],
    create: async (item) => { recreated.push(item.scheduleId); },
    pause: async () => undefined,
    resume: async () => undefined,
    remove: async (id) => { removed.push(id); },
  });
  assert.deepEqual(result.recreated.sort(), [active.scheduleId, changed.scheduleId].sort());
  assert.deepEqual(result.deleted, [cancelled.scheduleId]);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(recreated.sort(), result.recreated.sort());
  assert.deepEqual(removed, [cancelled.scheduleId]);
  assert.deepEqual(result.paused, []);
  assert.deepEqual(result.resumed, []);
});

test("schedule reconciliation leaves matching active schedules alone", async () => {
  const active = job("active", "schedule-ok");
  const result = await reconcileUserSchedules(1, {
    jobs: async () => [active],
    schedules: async () => [{ scheduleId: active.scheduleId, cron: active.cron, destination: "https://example.test/workflows/job" }],
    create: async () => { throw new Error("must not recreate"); },
    pause: async () => { throw new Error("must not pause"); },
    resume: async () => { throw new Error("must not resume"); },
    remove: async () => { throw new Error("must not remove"); },
  });
  assert.deepEqual(result, { checked: 1, recreated: [], deleted: [], paused: [], resumed: [], unchanged: [active.scheduleId] });
});

test("schedule reconciliation preserves paused job state and repairs provider drift", async () => {
  const paused = job("paused", "schedule-paused");
  const missing = job("paused", "schedule-missing-paused");
  const created: string[] = [];
  const pausedProvider: string[] = [];
  const result = await reconcileUserSchedules(1, {
    jobs: async () => [paused, missing],
    schedules: async () => [{ scheduleId: paused.scheduleId, cron: paused.cron, destination: "https://example.test/workflows/job", isPaused: false }],
    create: async (item) => { created.push(item.scheduleId); },
    pause: async (scheduleId) => { pausedProvider.push(scheduleId); },
    resume: async () => { throw new Error("must not resume a locally paused job"); },
    remove: async () => undefined,
  });
  assert.deepEqual(created, [missing.scheduleId]);
  assert.deepEqual(pausedProvider, [paused.scheduleId, missing.scheduleId]);
  assert.deepEqual(result, { checked: 2, recreated: [missing.scheduleId], deleted: [], paused: [paused.scheduleId, missing.scheduleId], resumed: [], unchanged: [] });
});

test("active schedule reconciliation resumes a provider-paused schedule", async () => {
  const active = job("active", "schedule-provider-paused");
  const resumed: string[] = [];
  const result = await reconcileUserSchedules(1, {
    jobs: async () => [active],
    schedules: async () => [{ scheduleId: active.scheduleId, cron: active.cron, destination: "https://example.test/workflows/job", isPaused: true }],
    create: async () => undefined,
    pause: async () => { throw new Error("must not pause an active job"); },
    resume: async (scheduleId) => { resumed.push(scheduleId); },
    remove: async () => undefined,
  });
  assert.deepEqual(resumed, [active.scheduleId]);
  assert.deepEqual(result, { checked: 1, recreated: [active.scheduleId], deleted: [], paused: [], resumed: [active.scheduleId], unchanged: [] });
});
