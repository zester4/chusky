import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createMission,
  getMission,
  initStore,
  listTasks,
  recordMissionSlice,
  startMission,
  updateMissionControl,
} from "../src/store.js";
import { nextMissionWorkAt, reconcileMissionExecution, rescheduleQueuedMissionTasks } from "../src/missionScheduler.js";
import { nativeTool } from "../src/nativeTools.js";
import { validateNativeToolArguments } from "../src/agentTools.js";

before(async () => { await initStore({ memoryOnly: true }); });

let workflow = 0;
const enqueue = async () => `mission-control-wf-${++workflow}`;

test("owner mission control reduces budgets within the saved ceiling and preserves usage", async () => {
  const userId = 971001;
  const created = await createMission(userId, {
    title: "Budget control",
    objective: "Prove bounded policy changes",
    definitionOfDone: "The policy is updated without resetting usage.",
    budget: { maxSlices: 20, maxToolCalls: 20, maxCost: 5 },
    budgetCeiling: { maxSlices: 50, maxToolCalls: 50, maxCost: 10 },
    steps: [{ id: "step", title: "Step", objective: "Make progress" }],
  });
  const started = await startMission(userId, created.id);
  assert.ok(started);
  await recordMissionSlice(userId, created.id, { checkpoint: "One slice", nextAction: "Continue", toolCalls: 3, cost: 0.25 });
  const updated = await updateMissionControl(userId, created.id, { budget: { maxSlices: 5, maxToolCalls: 8, maxCost: 1 } });
  assert.ok(updated);
  assert.equal(updated.budget.maxSlices, 5);
  assert.equal(updated.budget.maxToolCalls, 8);
  assert.equal(updated.budget.maxCost, 1);
  assert.equal(updated.consumedSlices, 1);
  assert.equal(updated.toolCalls, 3);
  assert.equal(updated.cost, 0.25);
  assert.match(updated.events.at(-1)?.message ?? "", /budget updated/);
});

test("mission control rejects budget increases above the owner ceiling", async () => {
  const userId = 971002;
  const created = await createMission(userId, {
    title: "Ceiling",
    objective: "Reject an unsafe increase",
    definitionOfDone: "The saved ceiling remains authoritative.",
    budgetCeiling: { maxSlices: 10 },
    steps: [{ id: "step", title: "Step", objective: "Wait" }],
  });
  await assert.rejects(() => updateMissionControl(userId, created.id, { budget: { maxSlices: 11 } }), /exceeds the owner's saved ceiling/);
  assert.equal((await getMission(userId, created.id))?.budget.maxSlices, 1000);
});

test("schedule control moves queued branches and leaves a live lease untouched", async () => {
  const userId = 971003;
  const original = { timezone: "UTC", windowStart: "09:00", windowEnd: "17:00", dailyBudgetSeconds: 3600, cadenceSeconds: 300 } as const;
  const changed = { timezone: "UTC", windowStart: "10:00", windowEnd: "18:00", dailyBudgetSeconds: 3600, cadenceSeconds: 300 } as const;
  const created = await createMission(userId, {
    title: "Schedule control",
    objective: "Move only queued work",
    definitionOfDone: "Queued work follows the new window.",
    workSchedule: original,
    steps: [{ id: "step", title: "Step", objective: "Run in the window" }],
  });
  const started = await startMission(userId, created.id);
  assert.ok(started);
  const scheduled = await reconcileMissionExecution(userId, created.id, enqueue);
  assert.ok(scheduled);
  const queued = (await listTasks(userId)).find((task) => task.missionId === created.id);
  assert.ok(queued);
  const updated = await updateMissionControl(userId, created.id, { workSchedule: changed });
  assert.ok(updated);
  const rescheduleAt = Date.now();
  const expectedRunAt = nextMissionWorkAt(changed, rescheduleAt);
  await rescheduleQueuedMissionTasks(userId, updated, rescheduleAt);
  const moved = (await listTasks(userId)).find((task) => task.id === queued.id);
  assert.ok(moved);
  assert.equal(moved.runAt, expectedRunAt);
  assert.equal(moved.status, "queued");
});

test("reducing an active budget below the consumed frontier blocks with a resume action", async () => {
  const userId = 971004;
  const created = await createMission(userId, {
    title: "Budget blocker",
    objective: "Expose an honest exhausted state",
    definitionOfDone: "The owner can resume after revising the budget.",
    budget: { maxSlices: 10 },
    budgetCeiling: { maxSlices: 20 },
    steps: [{ id: "step", title: "Step", objective: "Continue" }],
  });
  assert.ok(await startMission(userId, created.id));
  await recordMissionSlice(userId, created.id, { checkpoint: "Progress 1", nextAction: "Continue", toolCalls: 1 });
  await recordMissionSlice(userId, created.id, { checkpoint: "Progress 2", nextAction: "Continue", toolCalls: 1 });
  const blocked = await updateMissionControl(userId, created.id, { budget: { maxSlices: 1 } });
  assert.ok(blocked);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.nextAction ?? "", /budget|resume/i);
});

test("the mission worker can use native control to change its bounded schedule", async () => {
  const userId = 971005;
  const original = { timezone: "UTC", windowStart: "09:00", windowEnd: "12:00", dailyBudgetSeconds: 3600, cadenceSeconds: 300 } as const;
  const changed = { timezone: "UTC", windowStart: "13:00", windowEnd: "16:00", dailyBudgetSeconds: 3600, cadenceSeconds: 300 } as const;
  const created = await createMission(userId, {
    title: "Native control",
    objective: "Let the durable worker adjust its approved work window.",
    definitionOfDone: "The new work window is persisted and queued work follows it.",
    workSchedule: original,
    budgetCeiling: { maxSlices: 20 },
    steps: [{ id: "step", title: "Step", objective: "Run in the approved window" }],
  });
  assert.ok(await startMission(userId, created.id));
  await reconcileMissionExecution(userId, created.id, enqueue);
  const args = { id: created.id, budget: { maxSlices: 10 }, workSchedule: changed };
  validateNativeToolArguments("CHUCK_MISSION_CONTROL", args);
  const updated = await nativeTool(userId, "CHUCK_MISSION_CONTROL", args, { missionId: created.id, enqueueMissionTask: enqueue }) as { budget: { maxSlices: number }; workSchedule?: typeof changed };
  assert.equal(updated.budget.maxSlices, 10);
  assert.equal(updated.workSchedule?.windowStart, "13:00");
  assert.equal((await getMission(userId, created.id))?.workSchedule?.windowEnd, "16:00");
});
