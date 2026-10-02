import test, { before } from "node:test";
import assert from "node:assert/strict";
import { executeTaskSlice, type TaskSliceContext } from "../src/taskSlice.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { nativeTool } from "../src/nativeTools.js";
import { acquireUserLock, claimApproval, createApproval, createMission, getMission, getTask, initStore, listTasks, recordTrustedMissionEvidence, releaseUserLock, resumeMissionFromProviderEvent, startMission, waitMission } from "../src/store.js";
import { reconcileMissionExecution, replanMissionAndSchedule, resumeMissionAndSchedule } from "../src/missionScheduler.js";
import { resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import { ApprovalRequiredError } from "../src/agent.js";
import type { TaskWaitRequest, MissionWaitRequest } from "../src/types.js";
import { MissionFakeClock, MissionFakeQStash } from "./helpers/missionKernelHarness.js";

before(async () => { await initStore({ memoryOnly: true }); });

function context(queue: MissionFakeQStash, agent: NonNullable<TaskSliceContext["runAgent"]>): TaskSliceContext {
  return {
    attempt: 0, workflowRunId: "proof-workflow", enqueueMissionTask: queue.enqueue, runAgent: agent,
    sdkTaskMessage: async (task) => task?.objective ?? "", sdkTaskSkillInstructions: async () => undefined,
    sdkDurationSeconds: () => undefined, sendMessage: async () => undefined,
    withUserLock: async (userId, _signal, work) => {
      const token = `proof-owner-lock-${userId}`;
      assert.equal(await acquireUserLock(userId, token), true);
      try { return await work(); } finally { await releaseUserLock(userId, token); }
    },
  };
}

async function fixture(userId: number, queue: MissionFakeQStash) {
  const mission = await createMission(userId, { title: "Full slice proof", objective: "Run the production coordinator", definitionOfDone: "Step persisted complete", steps: [{ id: "unit", title: "Unit", objective: "Complete one bounded internal unit" }] });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id)!;
  return { mission, task };
}

test("full production slice executes a scripted model through real native dispatch and settlement", async () => {
  const userId = 982001;
  const queue = new MissionFakeQStash();
  const { mission, task } = await fixture(userId, queue);
  let calls = 0;
  const dependencies = context(queue, async (...args) => {
    calls++;
    const options = args[9];
    assert.equal(options?.missionId, mission.id);
    assert.equal(options?.missionStepId, "unit");
    await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "unit", result: "Internal unit verified" }, { taskId: task.id, missionId: mission.id, enqueueMissionTask: queue.enqueue });
    return { text: "Unit verified", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
  });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "full-proof-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies) });
  assert.equal(calls, 1);
  assert.equal(run.task?.status, "completed");
  assert.equal((await getMission(userId, mission.id))?.status, "completed");
});

test("full production slice parks an early timer wake without invoking the model", async () => {
  const userId = 982002;
  const queue = new MissionFakeQStash();
  const { mission, task } = await fixture(userId, queue);
  const runAt = Date.now() + 60000;
  await waitMission(userId, mission.id, { kind: "timer", stepId: "unit", runAt }, "Saved work", "Continue after wake");
  let calls = 0;
  const dependencies = context(queue, async () => { calls++; return { text: "Must not run", toolsUsed: [], toolsSucceeded: [] }; });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "early-timer-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies) });
  assert.equal(calls, 0);
  assert.equal(run.task?.status, "queued");
  assert.equal(run.task?.runAt, runAt);
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
});

test("full production slice does not run a model during a human-input wait", async () => {
  const userId = 982003;
  const queue = new MissionFakeQStash();
  const { mission, task } = await fixture(userId, queue);
  await waitMission(userId, mission.id, { kind: "human_input", stepId: "unit", key: "owner-choice" }, "Saved work", "Supply the missing owner choice, then resume this mission");
  let calls = 0;
  const dependencies = context(queue, async () => { calls++; return { text: "No choice supplied", toolsUsed: [], toolsSucceeded: [] }; });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "human-wait-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies) });
  assert.equal(calls, 0, "A human wait must not silently fall through to inference.");
  assert.equal(run.task?.status, "blocked");
  assert.match(run.task?.nextAction ?? "", /owner choice/);
  const persisted = await getMission(userId, mission.id);
  assert.equal(persisted?.status, "waiting");
  assert.equal(persisted?.waiting?.key, "owner-choice");
  assert.equal(persisted?.checkpoint, "Saved work");
  const resumed = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
  assert.equal(resumed?.id, mission.id);
  assert.equal(resumed?.status, "running");
  const completion = context(queue, async () => {
    calls++;
    await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "unit", result: "Owner choice supplied; unit verified" }, { taskId: task.id, missionId: mission.id, enqueueMissionTask: queue.enqueue });
    return { text: "Unit verified", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
  });
  const continued = await executeDurableTask({ userId, taskId: task.id }, { workerId: "human-resume-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, completion) });
  assert.equal(calls, 1);
  assert.equal(continued.task?.id, task.id);
  assert.equal(continued.task?.status, "completed");
  assert.equal((await getMission(userId, mission.id))?.status, "completed");
});

test("200-step production-coordinator soak mixes joins, waits, approvals, replans and failures", async () => {
  const userId = 982004;
  const clock = new MissionFakeClock();
  clock.install();
  try {
    const queue = new MissionFakeQStash();
    const steps = Array.from({ length: 200 }, (_, index) => {
      const wave = Math.floor(index / 5);
      const join = index % 5 === 4;
      return { id: `unit-${index}`, title: `Unit ${index}`, objective: "Execute and verify one bounded provider unit", evidenceRequired: ["kind:tool_receipt"],
        dependsOn: join ? Array.from({ length: 4 }, (_, branch) => `unit-${wave * 5 + branch}`) : wave ? [`unit-${wave * 5 - 1}`] : [],
      };
    });
    const mission = await createMission(userId, { title: "Mixed long mission", objective: "Complete all 200 verified units", definitionOfDone: "All 200 units have trusted receipts and completed steps", verificationMode: "strict", requiredEvidence: ["kind:tool_receipt"], budget: { maxSteps: 1000, maxToolCalls: 1000, maxCost: 25 }, steps });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);
    const attempted = new Set<string>();
    const effects = new Set<string>();
    let replanned = false;
    let slices = 0;
    for (; slices < 2000; slices++) {
      const before = (await getMission(userId, mission.id))!;
      if (before.status === "completed") break;
      if (before.waiting?.kind === "approval") {
        const approvalId = before.waiting.key!;
        assert.ok(await claimApproval(userId, approvalId));
        const resumed = await resumeMissionTaskAfterApproval(userId, approvalId, queue.enqueue);
        assert.equal(resumed.status, "resumed");
      } else if (before.waiting?.kind === "provider_event") {
        assert.ok(await resumeMissionFromProviderEvent(userId, mission.id, before.waiting.provider!, before.waiting.providerEventId!));
      }
      const current = (await getMission(userId, mission.id))!;
      assert.ok(["running", "waiting"].includes(current.status), `Unexpected terminal/blocker: ${current.status} ${current.error ?? ""}`);
      const deliveryIndex = queue.deliveries.findIndex((delivery) => delivery.runAt <= clock.now);
      if (deliveryIndex < 0) {
        const next = Math.min(...queue.deliveries.map((delivery) => delivery.runAt));
        assert.ok(Number.isFinite(next), "A nonterminal mission cannot lose all delivery wakes.");
        clock.advance(Math.max(1, next - clock.now));
      }
      const delivery = queue.deliveries.splice(queue.deliveries.findIndex((item) => item.runAt <= clock.now), 1)[0];
      assert.ok(delivery);
      const dependencies = context(queue, async (...args) => {
        const options = args[9]!;
        const stepId = options.missionStepId!;
        const ordinal = Number(stepId.split("-")[1]);
        const runtime = { taskId: options.taskId, missionId: mission.id, enqueueMissionTask: queue.enqueue };
        const once = (kind: string) => { const key = `${stepId}:${kind}`; if (attempted.has(key)) return false; attempted.add(key); return true; };
        if (ordinal % 37 === 11 && once("failure")) return { text: "I will do it later", toolsUsed: [], toolsSucceeded: [] };
        if (ordinal % 17 === 4 && once("timer")) {
          let request: TaskWaitRequest | undefined;
          await nativeTool(userId, "CHUCK_TASK_WAIT", { delaySeconds: 60, checkpoint: `Processing ${stepId}`, nextAction: `Read the result for ${stepId}` }, { ...runtime, requestTaskWait: (value) => { request = value; } });
          assert.ok(request);
          return { text: "Waiting for processing", toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], taskWait: request };
        }
        if (ordinal % 23 === 7 && once("event")) {
          let request: MissionWaitRequest | undefined;
          await nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", { id: mission.id, stepId, provider: "fixture", providerEventId: `event-${stepId}`, timeoutSeconds: 60, checkpoint: `Awaiting ${stepId}`, nextAction: `Verify event-${stepId}` }, { ...runtime, requestMissionWait: (value) => { request = value; } });
          assert.ok(request);
          return { text: "Waiting for exact provider event", toolsUsed: ["CHUCK_MISSION_WAIT_EVENT"], toolsSucceeded: ["CHUCK_MISSION_WAIT_EVENT"], missionWait: request };
        }
        if (ordinal % 31 === 9 && once("approval")) {
          const approval = await createApproval({ userId, toolSlug: "FIXTURE_APPROVED_ACTION", args: { stepId }, request: "Approve the exact fixture action", history: [], model: "test/model" });
          throw new ApprovalRequiredError(approval.id, approval.toolSlug, approval.args);
        }
        assert.equal(effects.has(stepId), false, "A provider unit cannot be repeated after confirmation.");
        effects.add(stepId);
        // This fixture is the trusted provider boundary. It produces a receipt,
        // not a model assertion; separate agent tests cover actual dispatch.
        await recordTrustedMissionEvidence(userId, mission.id, [{ id: `receipt-${stepId}`, kind: "tool_receipt", summary: `Provider unit ${stepId} confirmed`, ref: `fixture:${stepId}`, verified: true }], stepId);
        await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId, result: `Verified ${stepId}` }, runtime);
        return { text: `Verified ${stepId}`, toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
      });
      const run = await executeDurableTask({ userId, taskId: delivery.taskId }, { workerId: `soak-worker-${slices}`, execute: (task, signal) => executeTaskSlice(task, signal, dependencies) });
      if (run.task?.status === "queued") await queue.enqueue(userId, run.task.id, run.task.runAt!);
      if (!replanned && effects.size >= 50) {
        await replanMissionAndSchedule(userId, mission.id, steps, "Retain completed proofs and refresh remaining work", queue.enqueue);
        replanned = true;
      }
      if (slices % 13 === 0 && queue.deliveries.length) queue.duplicate();
      if (slices % 19 === 0) queue.reverse();
    }
    const completed = (await getMission(userId, mission.id))!;
    assert.equal(completed.status, "completed", `Did not finish after ${slices} slices: ${completed.error ?? completed.status}`);
    assert.equal(effects.size, 200);
    assert.equal(completed.steps.filter((step) => step.status === "completed").length, 200);
    assert.equal(completed.verification?.verified, true);
    assert.equal(replanned, true);
  } finally { clock.restore(); }
});

test("30-day production coordinator renews leases during three-hour windows and durably rests between days", async () => {
  const userId = 982005;
  const clock = new MissionFakeClock();
  clock.installTimers();
  try {
    const queue = new MissionFakeQStash();
    const contract = {
      title: "Thirty daily work windows", objective: "Verify one daily unit for thirty days", definitionOfDone: "Thirty distinct units are verified inside their daily windows",
      workSchedule: { timezone: "UTC", windowStart: "09:00", windowEnd: "12:00", dailyBudgetSeconds: 10800, cadenceSeconds: 300 },
      budget: { maxDurationSeconds: 30 * 10800, durationMode: "active" as const, maxLifetimeSeconds: 30 * 86400, maxSteps: 1000, maxToolCalls: 1000, maxCost: 25 },
      steps: Array.from({ length: 30 }, (_, day) => ({ id: `day-${day}`, title: `Day ${day + 1}`, objective: "Verify the daily unit", dependsOn: day ? [`day-${day - 1}`] : [], evidenceRequired: ["kind:tool_receipt"] })),
      verificationMode: "strict" as const, requiredEvidence: ["kind:tool_receipt"],
    };
    const mission = await createMission(userId, contract);
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);
    const completed = new Set<string>();
    for (let day = 0; day < 30; day++) {
      const start = Date.UTC(2026, 0, day + 1, 9);
      const deliveryIndex = queue.deliveries.findIndex((item) => item.runAt === start);
      assert.ok(deliveryIndex >= 0, `Day ${day + 1} must have an exact durable 09:00 wake, not a hot loop`);
      const delivery = queue.deliveries.splice(deliveryIndex, 1)[0];
      assert.ok(!queue.deliveries.some((item) => item.runAt < start && item.runAt >= clock.now), "No work may be scheduled during rest");
      await clock.advanceAsync(start - clock.now);
      // Rebuild the worker context each day; retained state lives in the real
      // store, not closures. Cross-process persistence is proved separately.
      const dependencies = context(queue, async (...args) => {
        const options = args[9]!;
        assert.equal(options.missionStepId, `day-${day}`);
        assert.equal(Date.now(), start);
        assert.equal(completed.has(options.missionStepId!), false);
        await clock.advanceAsync(10800000 - 1);
        assert.equal(args[5]?.aborted, false, "Heartbeat renewal must keep the active slice alive");
        assert.ok((await getTask(userId, options.taskId!))?.lease!.expiresAt! > clock.now);
        assert.ok(clock.now < Date.UTC(2026, 0, day + 1, 12), "Provider confirmation must occur inside the window");
        await recordTrustedMissionEvidence(userId, mission.id, [{ id: `receipt-day-${day}`, kind: "tool_receipt", summary: "Daily fixture provider unit verified", ref: `fixture:day-${day}`, verified: true }], options.missionStepId);
        await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: options.missionStepId, result: "Daily unit verified" }, { taskId: options.taskId, missionId: mission.id, enqueueMissionTask: queue.enqueue });
        completed.add(options.missionStepId!);
        return { text: "Daily unit verified", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
      });
      const run = await executeDurableTask({ userId, taskId: delivery.taskId }, { workerId: `daily-worker-${day}`, execute: (task, signal) => executeTaskSlice(task, signal, dependencies) });
      assert.equal(run.task?.status, "completed");
      assert.equal(clock.pendingTimers, 0, "Rest periods cannot retain worker heartbeat loops");
    }
    const final = (await getMission(userId, mission.id))!;
    assert.equal(final.status, "completed");
    assert.equal(final.verification?.verified, true);
    assert.equal(completed.size, 30);
  } finally { clock.restore(); }
});
