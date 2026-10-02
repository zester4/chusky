import test from "node:test";
import assert from "node:assert/strict";
import { boundedMissionHistory, captureMissionSliceState, missionHasTimerWakeContinuation, missionNoProgressNextAction, missionPostWakeNextAction, missionSliceHasPersistedProgress, missionStepInstruction, missionWakeNeedsRecovery, missionWorkerToolAllowlist, MISSION_WORKER_CONTROL_TOOLS } from "../src/missionWorker.js";

test("bounded mission history keeps only a recent bounded text frontier", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `message-${index}-${"x".repeat(900)}` }));
  const bounded = boundedMissionHistory(history);
  assert.equal(bounded.length, 8);
  assert.equal(bounded[0]?.content.toString().startsWith("message-4-"), true);
  assert.equal(bounded.at(-1)?.content.toString().startsWith("message-11-"), true);
  assert.equal(bounded.some((message) => message.content.includes("message-0-")), false);
  assert.ok(bounded.reduce((total, message) => total + String(message.content).length, 0) <= 8000);
});

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

test("mission worker fences provider tools while retaining lifecycle controls", () => {
  const allowed = missionWorkerToolAllowlist(["GMAIL_SEND_EMAIL", "HUBSPOT_CREATE_NOTE"]);
  assert.deepEqual(allowed?.filter((tool) => tool === "GMAIL_SEND_EMAIL" || tool === "HUBSPOT_CREATE_NOTE"), ["GMAIL_SEND_EMAIL", "HUBSPOT_CREATE_NOTE"]);
  assert.equal(allowed?.includes("GITHUB_DELETE_REPOSITORY"), false);
  for (const control of MISSION_WORKER_CONTROL_TOOLS) assert.equal(allowed?.includes(control), true);
  assert.deepEqual(missionWorkerToolAllowlist(undefined, ["TEST_SAFE_TOOL"]), ["TEST_SAFE_TOOL"]);
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

test("post-wake actions are step-specific even when the model supplied plan-level prose", () => {
  const action = missionPostWakeNextAction(
    { title: "Second readback", objective: "Read Sheet1!A1:C3 and compare it with the first readback." },
    "Continue the remaining mission plan.",
  );
  assert.match(action, /Second readback/);
  assert.match(action, /Read Sheet1!A1:C3/);
  assert.match(action, /Do not call CHUCK_TASK_WAIT again/);
  assert.match(action, /Continue the remaining mission plan/);
});

test("only a zero-tool timer wake receives an automatic recovery turn", () => {
  assert.equal(missionWakeNeedsRecovery(true, { toolsUsed: [] }), true);
  assert.equal(missionWakeNeedsRecovery(true, { toolsUsed: ["GOOGLESHEETS_VALUES_GET"] }), false);
  assert.equal(missionWakeNeedsRecovery(false, { toolsUsed: [] }), false);
  assert.equal(missionWakeNeedsRecovery(true, { toolsUsed: [], taskWait: {} }), false);
});

test("a later checkpoint consumes the timer wake marker", () => {
  const mission = {
    status: "running" as const,
    currentStepId: "checkpoint_and_wait",
    activeStepIds: ["checkpoint_and_wait"],
    events: [
      { id: "wake", type: "resumed" as const, message: "Timer wait reached for checkpoint_and_wait.", at: 2, stepId: "checkpoint_and_wait" },
      { id: "checkpoint", type: "checkpointed" as const, message: "Post-wake action persisted.", at: 3 },
    ],
  };
  assert.equal(missionHasTimerWakeContinuation(mission, "checkpoint_and_wait"), false);
});
