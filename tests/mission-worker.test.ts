import test from "node:test";
import assert from "node:assert/strict";
import { captureMissionSliceState, missionHasTimerWakeContinuation, missionNoProgressNextAction, missionSliceHasPersistedProgress, missionStepInstruction } from "../src/missionWorker.js";

test("a mission worker does not treat an unchanged slice as progress", () => {
  const task = { status: "running" as const, checkpoint: "before", nextAction: "Read the sheet", result: undefined, error: undefined, runAt: 1 };
  const mission = {
    status: "running" as const,
    checkpoint: "before",
    nextAction: "Finish the remaining plan",
    waiting: undefined,
    consumedSteps: 1,
    toolCalls: 2,
    cost: 0,
    currentStepId: "read",
    activeStepIds: ["read"],
    steps: [],
    evidence: [],
    events: [],
  };
  const state = captureMissionSliceState(task, mission);
  assert.equal(missionSliceHasPersistedProgress(state, captureMissionSliceState({ ...task }, { ...mission })), false);
});

test("mission lease bookkeeping is not mistaken for worker progress", () => {
  const base = {
    status: "running" as const,
    checkpoint: "before",
    nextAction: "Read",
    waiting: undefined,
    consumedSteps: 0,
    toolCalls: 0,
    cost: 0,
    currentStepId: "read",
    activeStepIds: ["read"],
    steps: [],
    evidence: [],
  };
  const before = captureMissionSliceState(undefined, { ...base, events: [{ id: "acquired", type: "lease_acquired", message: "lease", at: 1 }] });
  const after = captureMissionSliceState(undefined, { ...base, events: [
    { id: "acquired", type: "lease_acquired", message: "lease", at: 1 },
    { id: "released", type: "lease_released", message: "lease", at: 2 },
  ] });
  assert.equal(missionSliceHasPersistedProgress(before, after), false);
});

test("durable mission progress is detected from a persisted checkpoint or step transition", () => {
  const before = captureMissionSliceState(
    { status: "running", checkpoint: "before", nextAction: "Read", result: undefined, error: undefined, runAt: 1 },
    { status: "running", checkpoint: "before", nextAction: "Read", waiting: undefined, consumedSteps: 0, toolCalls: 0, cost: 0, currentStepId: "read", activeStepIds: ["read"], steps: [], evidence: [], events: [] },
  );
  const after = captureMissionSliceState(
    { status: "running", checkpoint: "sheet was read", nextAction: "Complete read", result: undefined, error: undefined, runAt: 1 },
    { status: "running", checkpoint: "sheet was read", nextAction: "Complete read", waiting: undefined, consumedSteps: 0, toolCalls: 1, cost: 0, currentStepId: "read", activeStepIds: ["read"], steps: [], evidence: [], events: [{ id: "event", type: "checkpointed", message: "read", at: 2 }] },
  );
  assert.equal(missionSliceHasPersistedProgress(before, after), true);
});

test("worker instructions name one executable step and its recovery action", () => {
  const step = { title: "Read the sheet", objective: "Read Sheet1!A1:D20 and persist the exact values." };
  assert.match(missionStepInstruction(step), /Execute only this mission step now/);
  assert.match(missionStepInstruction(step), /Read Sheet1!A1:D20/);
  assert.match(missionNoProgressNextAction(step), /Read the sheet/);
});

test("a supervisor-resumed timer remains a post-wake continuation for the same step", () => {
  const mission = {
    status: "running" as const,
    currentStepId: "checkpoint_and_wait",
    activeStepIds: ["checkpoint_and_wait"],
    events: [{ id: "wake", type: "resumed" as const, message: "Timer wait reached 2026-10-01T19:14:04.000Z.", at: 1, stepId: "checkpoint_and_wait" }],
  };
  assert.equal(missionHasTimerWakeContinuation(mission, "checkpoint_and_wait"), true);
  assert.equal(missionHasTimerWakeContinuation(mission, "second_readback"), false);
});
