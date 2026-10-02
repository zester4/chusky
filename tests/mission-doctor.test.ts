import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseMission } from "../src/reliability/missionDoctor.js";
import type { MissionRecord, TaskRecord } from "../src/store.js";

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "mis_doctor",
    userId: 990001,
    title: "Doctor proof",
    objective: "Advance the work.",
    definitionOfDone: "The work is complete.",
    status: "running",
    steps: [{ id: "step-1", title: "Step", objective: "Do it.", status: "running", dependsOn: [], attempts: 1, updatedAt: 1 }],
    activeStepIds: ["step-1"],
    budget: { maxDurationSeconds: 3600, maxSteps: 10, maxSlices: 20, maxToolCalls: 30, maxCost: 5 },
    consumedSteps: 0,
    consumedSlices: 1,
    toolCalls: 1,
    cost: 0.1,
    events: [],
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "task_doctor", userId: 990001, title: "Step", objective: "Do it.", status: "queued", missionId: "mis_doctor", missionStepId: "step-1", steps: [], attempt: 0, maxAttempts: 3, events: [], createdAt: 1, updatedAt: 1, version: 1, ...overrides };
}

test("mission doctor reports a running mission with a live queued task as healthy", () => {
  const report = diagnoseMission({ mission: mission(), tasks: [task({ runAt: 5_000 })], now: 1_000 });
  assert.equal(report.health, "healthy");
  assert.equal(report.summary, "Mission has a live executable path.");
  assert.deepEqual(report.reasons, []);
  assert.equal(report.budget.remainingSlices, 19);
});

test("mission doctor identifies an expired lease and gives a recovery action", () => {
  const report = diagnoseMission({ mission: mission(), tasks: [task({ status: "running", lease: { token: "redacted", workerId: "worker-1", acquiredAt: 1, expiresAt: 900 } })], now: 1_000 });
  assert.equal(report.health, "stalled");
  assert.ok(report.reasons.includes("expired_worker_lease"));
  assert.ok(report.nextActions.some((action) => /recovery/i.test(action)));
  assert.equal(report.tasks[0]?.lease?.workerId, "worker-1");
  assert.equal((report.tasks[0]?.lease as any)?.token, undefined);
});

test("mission doctor distinguishes an exact provider wait from a stranded mission", () => {
  const report = diagnoseMission({ mission: mission({ status: "waiting", waiting: { kind: "provider_event", provider: "stripe", providerEventId: "evt_1", expiresAt: 5_000 } }), tasks: [], now: 1_000 });
  assert.equal(report.health, "waiting");
  assert.deepEqual(report.waiting, { kind: "provider_event", provider: "stripe", providerEventId: "evt_1", expiresAt: 5_000, overdue: false });
  assert.ok(report.nextActions.some((action) => /exact signed provider event/i.test(action)));
});

test("mission doctor reports uncertain provider failure as blocked and never recommends blind replay", () => {
  const report = diagnoseMission({ mission: mission({ status: "blocked", error: "Provider outcome is uncertain." }), tasks: [task({ status: "blocked", lastFailureClass: "provider_uncertain", error: "Timeout after dispatch." })], now: 1_000 });
  assert.equal(report.health, "blocked");
  assert.ok(report.reasons.includes("provider_outcome_uncertain"));
  assert.ok(report.nextActions.every((action) => !/retry blindly|replay blindly/i.test(action)));
});
