import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask, checkpointMission, createMission, createTask, getMission, getTask, initStore,
  completeMissionStep, replanMission, renewTaskLease, resumeMissionFromProviderEvent,
  resumeMissionFromTimer, settleTaskRun, startMission, waitMission,
  recordMissionSlice,
} from "../src/store.js";
import { reconcileMissionExecution } from "../src/missionScheduler.js";
import { captureMissionSliceState, missionSliceHasPersistedProgress } from "../src/missionWorker.js";
import { settleMissionSlice } from "../src/missionSlice.js";
import { MissionFakeClock, MissionFakeQStash, MissionCrashInjector, MissionCrash } from "./helpers/missionKernelHarness.js";
import { nativeTool } from "../src/nativeTools.js";
import { missionWorkerToolAllowlist } from "../src/missionWorker.js";
import { beginExternalAction, failExternalAction } from "../src/autonomy/actions.js";
import { executeCompensation, listCompensations } from "../src/reliability/persistence.js";

before(async () => { await initStore({ memoryOnly: true }); });

async function withClock(run: (clock: MissionFakeClock) => Promise<void>): Promise<void> {
  const clock = new MissionFakeClock();
  clock.install();
  try { await run(clock); } finally { clock.restore(); }
}

test("proof transport can duplicate, delay, reorder and drop real task deliveries", async () => withClock(async (clock) => {
  const queue = new MissionFakeQStash();
  const task = await createTask(980001, { title: "Delivery proof", objective: "Claim exactly once" });
  await queue.enqueue(task.userId, task.id, clock.now);
  queue.duplicate();
  queue.delay(0, 2000);
  queue.reverse();
  assert.ok((await queue.claimNext(clock.now))?.claimed);
  clock.advance(2000);
  assert.equal((await queue.claimNext(clock.now))?.claimed, undefined);
  await queue.enqueue(task.userId, task.id, clock.now);
  queue.drop();
  assert.equal(queue.deliveries.length, 0);
  assert.equal(queue.published.length, 2);
}));

test("proof expired workers cannot renew or settle their old lease", async () => withClock(async (clock) => {
  const task = await createTask(980002, { title: "Lease fence", objective: "Reject stale writes" });
  const claimed = await claimTask(task.userId, task.id, "crashed-worker", 1000);
  assert.ok(claimed?.lease);
  clock.advance(1001);
  assert.equal(await renewTaskLease(task.userId, task.id, claimed.lease.token), undefined);
  assert.equal(await settleTaskRun(task.userId, task.id, claimed.lease.token, { status: "completed", message: "stale" }), undefined);
}));

test("proof crash after claim can be recovered without a second task identity", async () => withClock(async (clock) => {
  const task = await createTask(980003, { title: "Crash recovery", objective: "Retain the work identity" });
  const injector = new MissionCrashInjector("claim:after");
  await assert.rejects(injector.awaitBoundary("claim", () => claimTask(task.userId, task.id, "dead-worker", 1000)), MissionCrash);
  clock.advance(1001);
  const recovered = await claimTask(task.userId, task.id, "replacement-worker", 1000);
  assert.ok(recovered?.lease, "An expired running lease must be recoverable.");
  assert.equal(recovered.id, task.id);
}));

test("proof inserting 200 tasks never evicts unfinished work", async () => {
  const first = await createTask(980004, { title: "Keep me", objective: "Unfinished durable work" });
  for (let index = 0; index < 200; index++) await createTask(first.userId, { title: `Task ${index}`, objective: "Pending work" });
  assert.ok(await getTask(first.userId, first.id), "Retention cannot silently delete an unfinished task.");
});

test("proof a 200-step DAG can be created and its root scheduled", async () => {
  const steps = Array.from({ length: 200 }, (_, index) => ({ id: `step-${index}`, title: `Step ${index}`, objective: "Perform and verify one unit", dependsOn: index ? [`step-${index - 1}`] : [] }));
  const mission = await createMission(980005, { title: "Long plan", objective: "Complete 200 units", definitionOfDone: "All units verified", steps });
  await startMission(mission.userId, mission.id);
  const queue = new MissionFakeQStash();
  await reconcileMissionExecution(mission.userId, mission.id, queue.enqueue);
  assert.equal((await getMission(mission.userId, mission.id))?.steps.length, 200);
  assert.equal(queue.published.length, 1);
});

test("proof timer resume cannot bypass the saved future deadline", async () => withClock(async (clock) => {
  const mission = await createMission(980006, { title: "Timer", objective: "Wait honestly", definitionOfDone: "Deadline reached", steps: [{ id: "wait", title: "Wait", objective: "Wait before continuing" }] });
  await startMission(mission.userId, mission.id);
  const runAt = clock.now + 60000;
  await waitMission(mission.userId, mission.id, { kind: "timer", runAt, stepId: "wait" }, "Saved", "Continue after deadline");
  assert.equal(await resumeMissionFromTimer(mission.userId, mission.id, runAt), undefined);
  assert.equal((await getMission(mission.userId, mission.id))?.status, "waiting");
  clock.advance(60000);
  assert.equal((await resumeMissionFromTimer(mission.userId, mission.id, runAt))?.status, "running");
}));

test("proof timer metadata measures the persisted parked wait, not only scheduler lateness", async () => withClock(async (clock) => {
  const mission = await createMission(980010, { title: "Timer metadata", objective: "Measure the durable wait", definitionOfDone: "The timer measurement is authoritative", steps: [{ id: "wait", title: "Wait", objective: "Wait for the timer" }] });
  await startMission(mission.userId, mission.id);
  const parkedAt = clock.now;
  const runAt = parkedAt + 60000;
  await waitMission(mission.userId, mission.id, { kind: "timer", runAt, stepId: "wait" }, "Saved", "Continue after deadline");
  clock.advance(90000);
  const resumed = await resumeMissionFromTimer(mission.userId, mission.id, runAt);
  const event = resumed?.events.at(-1);
  assert.equal(event?.type, "resumed");
  assert.equal(event?.metadata?.timerParkedAt, parkedAt);
  assert.equal(event?.metadata?.timerRunAt, runAt);
  assert.equal(event?.metadata?.elapsedMs, 90000);
  assert.equal(event?.metadata?.scheduledDelayMs, 60000);
  assert.equal(event?.metadata?.overdueMs, 30000);
}));

test("proof preserves checkpoint history when a timer wait replaces the active pointer", async () => withClock(async (clock) => {
  const mission = await createMission(980011, { title: "Checkpoint history", objective: "Retain every recovery frontier", definitionOfDone: "Every checkpoint remains inspectable", steps: [{ id: "wait", title: "Wait", objective: "Wait and continue" }] });
  await startMission(mission.userId, mission.id);
  await checkpointMission(mission.userId, mission.id, "Baseline", "Enter the wait");
  const runAt = clock.now + 60000;
  await waitMission(mission.userId, mission.id, { kind: "timer", runAt, stepId: "wait" }, "Before wait", "Continue after the wait");
  clock.advance(60000);
  await resumeMissionFromTimer(mission.userId, mission.id, runAt);
  await checkpointMission(mission.userId, mission.id, "After wait", "Finish the step");
  await recordMissionSlice(mission.userId, mission.id, { checkpoint: "Worker frontier", nextAction: "Complete the step." });
  const current = await getMission(mission.userId, mission.id);
  assert.equal(current?.checkpoint, "Worker frontier");
  assert.deepEqual(current?.checkpointHistory?.map((item) => item.checkpoint), ["Baseline", "Before wait", "After wait", "Worker frontier"]);
  assert.deepEqual(current?.checkpointHistory?.map((item) => item.kind), ["checkpoint", "wait", "checkpoint", "checkpoint"]);
}));

test("proof provider replay uses exact provider and event identity", async () => {
  const mission = await createMission(980007, { title: "Event", objective: "Match exact event", definitionOfDone: "Exact event received", steps: [{ id: "event", title: "Event", objective: "Wait for event" }] });
  await startMission(mission.userId, mission.id);
  await waitMission(mission.userId, mission.id, { kind: "provider_event", provider: "gmail", providerEventId: "event-123", stepId: "event" });
  assert.ok(await resumeMissionFromProviderEvent(mission.userId, mission.id, "gmail", "event-123"));
  // A webhook retry after resume must remain schedulable even if the first
  // process died between the mission CAS and its task publication.
  const queue = new MissionFakeQStash();
  const resumedAgain = await resumeMissionFromProviderEvent(mission.userId, mission.id, "gmail", "event-123");
  assert.equal(resumedAgain?.status, "running");
  const scheduled = await reconcileMissionExecution(mission.userId, mission.id, queue.enqueue);
  assert.ok(scheduled?.activeStepIds?.includes("event"));
  assert.equal(await resumeMissionFromProviderEvent(mission.userId, mission.id, "different-provider", "123"), undefined);
});

test("proof replan retains unchanged step tool fences and evidence requirements", async () => {
  const mission = await createMission(980008, { title: "Replan", objective: "Preserve contract", definitionOfDone: "Receipt verified", steps: [{ id: "read", title: "Read", objective: "Read exact resource", allowedTools: ["GMAIL_FETCH_EMAILS"], evidenceRequired: ["tool_receipt"] }] });
  await startMission(mission.userId, mission.id);
  const updated = await replanMission(mission.userId, mission.id, [{ id: "read", title: "Read", objective: "Read exact resource" }], "Retry the same work");
  assert.deepEqual(updated?.steps[0].allowedTools, ["GMAIL_FETCH_EMAILS"]);
  assert.deepEqual(updated?.steps[0].evidenceRequired, ["tool_receipt"]);
});

test("proof real persisted progress restarts the consecutive failure budget", async () => withClock(async (clock) => {
  const userId = 980009;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, { title: "Long step retry", objective: "Survive a late stumble", definitionOfDone: "Verified unit complete", steps: [{ id: "unit", title: "Unit", objective: "Persist several intermediate results" }] });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const taskId = (await getMission(userId, mission.id))!.rootTaskId!;
  for (let slice = 0; slice < 4; slice++) {
    const claimed = await claimTask(userId, taskId, `worker-${slice}`, 1000);
    assert.ok(claimed?.lease);
    const current = (await getMission(userId, mission.id))!;
    const before = captureMissionSliceState(claimed, current);
    await checkpointMission(userId, mission.id, `Verified intermediate result ${slice}`, "Continue the unit");
    const outcome = await settleMissionSlice({ task: claimed, mission: current, before, enqueue: queue.enqueue, result: { text: "Progress persisted", toolsUsed: ["CHUCK_MISSION_CHECKPOINT"] } });
    const settled = await settleTaskRun(userId, taskId, claimed.lease.token, outcome);
    assert.equal(settled?.attempt, 0, "Healthy slices cannot consume the consecutive failure budget.");
    clock.advance(5000);
  }
}));

test("proof an uncertain sibling action blocks even when another call and checkpoint succeeded", async () => {
  const userId = 980010;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, { title: "Mixed provider outcomes", objective: "Never replay uncertain work", definitionOfDone: "Both messages verified", steps: [{ id: "send", title: "Send", objective: "Send two distinct messages" }] });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const taskId = (await getMission(userId, mission.id))!.rootTaskId!;
  const task = (await claimTask(userId, taskId, "mixed-outcome-worker"))!;
  const current = (await getMission(userId, mission.id))!;
  const before = captureMissionSliceState(task, current);
  await checkpointMission(userId, mission.id, "The first message succeeded; the second timed out", "Inspect the second provider outcome");
  const result = {
    text: "The first succeeded, the second is unknown", toolsUsed: ["GMAIL_SEND_EMAIL"], toolsSucceeded: ["GMAIL_SEND_EMAIL"],
    toolOutcomes: [
      { callId: "first-call", toolSlug: "GMAIL_SEND_EMAIL", status: "succeeded", dispatched: true, receiptId: "first-receipt" },
      { callId: "second-call", toolSlug: "GMAIL_SEND_EMAIL", status: "uncertain", dispatched: true },
    ],
  };
  const outcome = await settleMissionSlice({ task, mission: current, before, enqueue: queue.enqueue, result });
  assert.equal(outcome.status, "blocked", "Persisted progress must never conceal a dispatched uncertain sibling.");
  assert.match(outcome.nextAction ?? "", /inspect|verify|reconcile/i);
});

test("proof an uncertain mission write queues one durable compensation and never duplicates it", async () => {
  const userId = 980015;
  const mission = await createMission(userId, {
    title: "Compensation path",
    objective: "Recover safely from an uncertain provider write",
    definitionOfDone: "The uncertain write is reconciled or compensated",
    steps: [{ id: "send", title: "Send", objective: "Send one message", compensationObjective: "Undo the message if the provider confirms it was sent" }],
  });
  const claim = await beginExternalAction({
    userId,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args: { to: "owner@example.com", subject: "Mission test" },
    runId: "run_compensation-proof",
    source: { kind: "mission", id: mission.id, missionStepId: "send", occurrenceId: "occurrence-1" },
  });
  assert.equal(claim.state, "new");
  await failExternalAction(userId, claim.logicalActionId, "provider timeout");
  await failExternalAction(userId, claim.logicalActionId, "duplicate webhook retry");

  const pending = await listCompensations(userId, ["pending"]);
  assert.equal(pending.length, 1, "Repeated uncertainty must create one compensation record.");
  assert.equal(pending[0]?.missionId, mission.id);
  assert.equal(pending[0]?.missionStepId, "send");

  let dispatches = 0;
  const settled = await executeCompensation({
    ownerId: userId,
    id: pending[0]!.id,
    approvalId: "approval_compensation-proof",
    toolSlug: "GMAIL_DELETE_MESSAGE",
    argumentsHash: "stable-compensation-args",
    execute: async () => {
      dispatches += 1;
      return { summary: "provider state reconciled", externalReceiptId: "comp-receipt-1", verificationId: "comp-verify-1" };
    },
  });
  assert.equal(settled?.status, "succeeded");
  assert.equal(dispatches, 1);
  assert.equal((await executeCompensation({
    ownerId: userId,
    id: pending[0]!.id,
    approvalId: "different-approval",
    toolSlug: "GMAIL_DELETE_MESSAGE",
    argumentsHash: "stable-compensation-args",
    execute: async () => { dispatches += 1; return { summary: "must not run", externalReceiptId: "duplicate", verificationId: "duplicate" }; },
  }))?.status, "succeeded");
  assert.equal(dispatches, 1, "A completed compensation must be idempotent across approval retries.");
});

test("proof per-call outcomes charge repeated provider calls individually", async () => {
  const userId = 980012;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, { title: "Per-call accounting", objective: "Count every provider call", definitionOfDone: "The calls are accounted", steps: [{ id: "send", title: "Send", objective: "Send two distinct messages" }] });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const taskId = (await getMission(userId, mission.id))!.rootTaskId!;
  const task = (await claimTask(userId, taskId, "per-call-worker"))!;
  const current = (await getMission(userId, mission.id))!;
  const before = captureMissionSliceState(task, current);
  await checkpointMission(userId, mission.id, "Both provider calls returned receipts", "Record the verified call count");
  const outcome = await settleMissionSlice({
    task,
    mission: current,
    before,
    enqueue: queue.enqueue,
    result: {
      text: "Two messages sent.",
      toolsUsed: ["GMAIL_SEND_EMAIL"],
      toolOutcomes: [
        { callId: "first-call", toolSlug: "GMAIL_SEND_EMAIL", status: "succeeded", dispatched: true, receiptId: "receipt-1" },
        { callId: "second-call", toolSlug: "GMAIL_SEND_EMAIL", status: "succeeded", dispatched: true, receiptId: "receipt-2" },
      ],
    },
  });
  assert.equal(outcome.status, "queued");
  assert.equal((await getMission(userId, mission.id))?.toolCalls, 2);
});

test("proof a 30-day mission executes only within its three-hour daily window", async () => withClock(async (clock) => {
  const userId = 980011;
  const queue = new MissionFakeQStash();
  const contract = {
    title: "Thirty-day scheduled work", objective: "Complete one three-hour unit each day", definitionOfDone: "Thirty daily units are verified",
    workSchedule: { timezone: "UTC", windowStart: "09:00", windowEnd: "12:00", dailyBudgetSeconds: 10800, cadenceSeconds: 300 },
    budget: { maxDurationSeconds: 30 * 10800, durationMode: "active" as const, maxLifetimeSeconds: 30 * 86400, maxSteps: 1000, maxToolCalls: 1000, maxCost: 25 },
    steps: Array.from({ length: 30 }, (_, index) => ({ id: `day-${index}`, title: `Day ${index + 1}`, objective: "Execute a verified daily unit", dependsOn: index ? [`day-${index - 1}`] : [] })),
  };
  const mission = await createMission(userId, contract);
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  for (let day = 0; day < 30; day++) {
    // A fresh transport consumer each day models worker restarts. The store is
    // intentionally not reinitialized; this is not a disk/Redis crash proof.
    const expectedStart = Date.UTC(2026, 0, 1 + day, 9);
    const delivery = queue.deliveries.find((candidate) => candidate.runAt >= clock.now);
    assert.ok(delivery, "Every rest period needs a durable scheduled wake.");
    assert.equal(delivery.runAt, expectedStart, "The scheduler must not publish a hot-loop wake outside the work window.");
    clock.advance(expectedStart - clock.now);
    const wake = await queue.claimNext(clock.now, 600000);
    assert.ok(wake?.claimed?.lease);
    for (let interval = 0; interval < 36; interval++) {
      clock.advance(300000);
      assert.ok(await renewTaskLease(userId, wake.claimed.id, wake.claimed.lease.token, 600000));
    }
    await completeMissionStep(userId, mission.id, wake.claimed.missionStepId!, `Daily unit ${day + 1} verified`);
    const current = (await getMission(userId, mission.id))!;
    const outcome = await settleMissionSlice({ task: wake.claimed, mission: current, before: captureMissionSliceState(wake.claimed, mission), enqueue: queue.enqueue, result: { text: "Daily unit complete", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"] } });
    await settleTaskRun(userId, wake.claimed.id, wake.claimed.lease.token, outcome);
    assert.equal(new Date(clock.now).getUTCHours(), 12);
  }
  assert.equal((await getMission(userId, mission.id))?.status, "completed");
}));

test("proof repeating an identical checkpoint does not create a new progress frontier", async () => {
  const userId = 980012;
  const mission = await createMission(userId, { title: "Repeated checkpoint", objective: "Bound a stuck model", definitionOfDone: "Actual work advances", steps: [{ id: "unit", title: "Unit", objective: "Advance beyond the same checkpoint" }] });
  await startMission(userId, mission.id);
  await checkpointMission(userId, mission.id, "Unchanged state", "Perform the next action");
  const before = captureMissionSliceState(undefined, (await getMission(userId, mission.id))!);
  await checkpointMission(userId, mission.id, "Unchanged state", "Perform the next action");
  const after = captureMissionSliceState(undefined, (await getMission(userId, mission.id))!);
  assert.equal(missionSliceHasPersistedProgress(before, after), false, "Event IDs are bookkeeping, not real progress.");
});

test("proof an accepted but lost publication is recoverable with the same task identity", async () => withClock(async (clock) => {
  const userId = 980013;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, {
    title: "Lost delivery", objective: "Recover independently of the lost wake",
    definitionOfDone: "The original unit is executed and verified",
    steps: [{ id: "unit", title: "Unit", objective: "Execute the same durable unit" }],
  });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const taskId = (await getMission(userId, mission.id))!.rootTaskId!;
  assert.ok((await getTask(userId, taskId))?.workflowRunId);
  queue.drop();
  clock.advance(86400000);
  // This is the existing operator recovery entry point, not an invented
  // sweeper. It must eventually replace an accepted wake that never arrived.
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  assert.equal(queue.deliveries.length, 1, "A persisted provider workflow ID cannot strand queued work forever.");
  assert.equal(queue.deliveries[0].taskId, taskId, "Recovery must preserve the original work identity.");
}));

test("proof a worker extends and shrinks its budget only within the owner's saved ceilings", async () => {
  const userId = 980014;
  const queue = new MissionFakeQStash();
  const contract = {
    title: "Self-managed budget", objective: "Choose the needed allowance inside owner authority",
    definitionOfDone: "Work fits the adjusted allowance without changing authority",
    budget: { maxDurationSeconds: 600, maxSteps: 2, maxToolCalls: 4, maxCost: 1 },
    budgetCeiling: { maxDurationSeconds: 3600, maxSteps: 20, maxToolCalls: 100, maxCost: 5 },
    steps: [{ id: "unit", title: "Unit", objective: "Complete a verified unit" }],
  };
  const mission = await createMission(userId, contract);
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const runtime = { taskId: (await getMission(userId, mission.id))!.rootTaskId, missionId: mission.id, enqueueMissionTask: queue.enqueue };
  await nativeTool(userId, "CHUCK_MISSION_RESUME", { id: mission.id, budget: { maxDurationSeconds: 1200, maxSteps: 10, maxToolCalls: 40, maxCost: 3 } }, runtime);
  assert.equal((await getMission(userId, mission.id))?.budget.maxDurationSeconds, 1200, "A permitted extension cannot require another owner turn.");
  await nativeTool(userId, "CHUCK_MISSION_RESUME", { id: mission.id, budget: { maxDurationSeconds: 900, maxSteps: 8, maxToolCalls: 30, maxCost: 2 } }, runtime);
  assert.equal((await getMission(userId, mission.id))?.budget.maxDurationSeconds, 900, "The worker must be able to shrink unused allowance.");
  assert.equal((await getMission(userId, mission.id))?.budget.maxCost, 2);
  await assert.rejects(nativeTool(userId, "CHUCK_MISSION_RESUME", { id: mission.id, budget: { maxCost: 6 } }, runtime), /approval|ceiling/i);
  assert.equal((await getMission(userId, mission.id))?.budget.maxCost, 2, "Exceeding a ceiling cannot silently authorize more spend.");
});

test("proof the worker can reach its existing budget-control tool inside a fenced step", () => {
  assert.ok(missionWorkerToolAllowlist([])?.includes("CHUCK_MISSION_RESUME"), "Budget adjustment must not depend on an unavailable supervisor control.");
});

test("proof plan-step accounting is independent of healthy slice accounting", async () => {
  const userId = 980015;
  const contract = {
    title: "Many slices, two plan steps", objective: "Advance a long unit without consuming another plan step",
    definitionOfDone: "Both plan steps verified", budget: { maxSteps: 2, maxSlices: 200 },
    steps: [{ id: "a", title: "A", objective: "Persist several intermediate results" }, { id: "b", title: "B", objective: "Verify the result", dependsOn: ["a"] }],
  };
  const mission = await createMission(userId, contract);
  await startMission(userId, mission.id);
  for (let slice = 0; slice < 10; slice++) {
    const accounted = await recordMissionSlice(userId, mission.id, { checkpoint: `Verified unit frontier ${slice}`, nextAction: "Advance the next frontier", toolCalls: 1 });
    assert.equal(accounted?.status, "running", "Intermediate slices cannot exhaust a two-step plan's allowance.");
  }
});
