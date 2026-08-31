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
    remove: async (id) => { removed.push(id); },
  });
  assert.deepEqual(result.recreated.sort(), [active.scheduleId, changed.scheduleId].sort());
  assert.deepEqual(result.deleted, [cancelled.scheduleId]);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(recreated.sort(), result.recreated.sort());
  assert.deepEqual(removed, [cancelled.scheduleId]);
});

test("schedule reconciliation leaves matching active schedules alone", async () => {
  const active = job("active", "schedule-ok");
  const result = await reconcileUserSchedules(1, {
    jobs: async () => [active],
    schedules: async () => [{ scheduleId: active.scheduleId, cron: active.cron, destination: "https://example.test/workflows/job" }],
    create: async () => { throw new Error("must not recreate"); },
    remove: async () => { throw new Error("must not remove"); },
  });
  assert.deepEqual(result, { checked: 1, recreated: [], deleted: [], unchanged: [active.scheduleId] });
});
