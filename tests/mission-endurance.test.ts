import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { ApprovalRequiredError } from "../src/agent.js";
import { executeTaskSlice, type TaskSliceContext } from "../src/taskSlice.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { nativeTool } from "../src/nativeTools.js";
import { enqueueTaskWithClaim } from "../src/taskEnqueue.js";
import {
  acquireUserLock,
  claimApproval,
  createApproval,
  createMission,
  getMission,
  initStore,
  listTasksForMission,
  recordTrustedMissionEvidence,
  releaseUserLock,
  renewUserLock,
  resumeMissionFromProviderEvent,
  startMission,
  type MissionRecord,
} from "../src/store.js";
import { reconcileMissionExecution, resumeMissionAndSchedule } from "../src/missionScheduler.js";
import { recoverMissionsForOwner } from "../src/missionRecovery.js";
import { resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import type { MissionWaitRequest, TaskWaitRequest } from "../src/types.js";
import { MissionFakeClock, MissionFakeQStash } from "./helpers/missionKernelHarness.js";

/**
 * This is an endurance proof, not a mocked workflow test. It runs the real
 * durable task runner, mission scheduler, task leases, mission leases,
 * account-lock renewal, native lifecycle tools, recovery sweep, and fake
 * QStash boundary. The only replaced boundary is model/provider work.
 */

const originalJevMode = config.jevMode;

before(async () => {
  config.jevMode = "off";
  await initStore({ memoryOnly: true });
});

after(() => { config.jevMode = originalJevMode; });

function context(queue: MissionFakeQStash, agent: NonNullable<TaskSliceContext["runAgent"]>): TaskSliceContext {
  return {
    attempt: 0,
    workflowRunId: "endurance-worker",
    enqueueMissionTask: queue.enqueue,
    runAgent: agent,
    sdkTaskMessage: async (task) => task?.objective ?? "",
    sdkTaskSkillInstructions: async () => undefined,
    sdkDurationSeconds: () => undefined,
    sendMessage: async () => undefined,
    // Match the production owner lock: a long provider/model slice renews the
    // account lock rather than silently letting it expire after three minutes.
    withUserLock: async (userId, signal, work) => {
      const token = `endurance-owner-lock-${userId}`;
      assert.equal(await acquireUserLock(userId, token), true);
      const renewal = setInterval(() => {
        if (!signal?.aborted) void renewUserLock(userId, token, 180);
      }, 60_000);
      try {
        return await work();
      } finally {
        clearInterval(renewal);
        await releaseUserLock(userId, token);
      }
    },
  };
}

function phaseFromCheckpoint(mission: MissionRecord, stepId: string): 0 | 1 | 2 {
  const checkpoint = mission.checkpoint ?? "";
  if (checkpoint === `${stepId}:phase-2`) return 2;
  if (checkpoint === `${stepId}:phase-1`) return 1;
  return 0;
}

function activeStepId(mission: MissionRecord): string {
  const stepId = mission.activeStepIds?.[0] ?? mission.currentStepId;
  assert.ok(stepId, `Mission ${mission.id} must have an active step.`);
  return stepId;
}

function activeMinutes(day: number, phase: 0 | 1 | 2): number {
  if (phase === 0) return 3 + ((day * 7) % 3); // three to five minutes
  if (phase === 1) return 4 + ((day * 5) % 7); // four to ten minutes
  return 5 + ((day * 3) % 6); // five to ten minutes
}

function firstSleepSeconds(day: number): number {
  // The durable task contract intentionally floors waits at sixty seconds;
  // exercise the shortest supported sleep and vary it up to two minutes.
  return 60 + ((day * 17) % 61); // one to two minutes
}

function secondSleepSeconds(day: number): number {
  return 120 + ((day * 29) % 181); // two to five minutes
}

test("21-day mission endurance survives repeated active slices, sleeps, callbacks, approvals, recovery, and late delivery", async () => {
  const userId = 983100;
  const clock = new MissionFakeClock(Date.UTC(2026, 0, 1, 9));
  clock.installTimers();
  try {
    const queue = new MissionFakeQStash();
    const dayCount = 21;
    const initialTime = clock.now;
    const mission = await createMission(userId, {
      title: "Twenty-one day endurance mission",
      objective: "Process one verified work unit each day through durable active slices and rest windows.",
      definitionOfDone: "Every daily unit has a trusted provider receipt and every scheduled work window has completed.",
      verificationMode: "strict",
      requiredEvidence: ["kind:tool_receipt"],
      workSchedule: { timezone: "UTC", windowStart: "09:00", windowEnd: "10:00", dailyBudgetSeconds: 3600, cadenceSeconds: 3600 },
      budget: {
        durationMode: "active",
        maxDurationSeconds: dayCount * 3600,
        maxLifetimeSeconds: 22 * 86400,
        maxSteps: dayCount + 5,
        maxSlices: dayCount * 6,
        maxToolCalls: dayCount * 12,
        maxCost: 25,
      },
      steps: Array.from({ length: dayCount }, (_, index) => ({
        id: `day-${index + 1}`,
        title: `Day ${index + 1}`,
        objective: "Perform the daily bounded work, persist the checkpoint, and verify the provider result.",
        dependsOn: index === 0 ? [] : [`day-${index}`],
        evidenceRequired: ["kind:tool_receipt"],
      })),
    });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);

    const phaseVisits = new Map<string, number[]>();
    const workerSlices: Array<{ day: number; phase: number; at: number; timerResumed: boolean }> = [];
    let timerWakes = 0;
    let providerWakes = 0;
    let approvalWakes = 0;
    let activeWorkMs = 0;
    let lostPublicationRecovered = false;
    let workerInvocations = 0;

    const runAgent = async (...args: any[]) => {
      const options = args[9] as { taskId?: string; missionId?: string; missionStepId?: string; missionTimerResumed?: boolean };
      assert.equal(options.missionId, mission.id);
      assert.ok(options.taskId);
      assert.ok(options.missionStepId);
      const stepId = options.missionStepId!;
      const day = Number(stepId.slice("day-".length));
      assert.ok(Number.isInteger(day) && day >= 1 && day <= dayCount);
      const persisted = await getMission(userId, mission.id);
      assert.ok(persisted);
      const phase = phaseFromCheckpoint(persisted, stepId);
      const visits = phaseVisits.get(stepId) ?? [];
      visits.push(phase);
      phaseVisits.set(stepId, visits);
      workerSlices.push({ day, phase, at: clock.now, timerResumed: options.missionTimerResumed === true });

      // Every phase represents real active work. Advancing virtual time through
      // the production timers exercises task, mission, and account-lock renewal
      // without making the test wait for the simulated minutes.
      const workMs = activeMinutes(day, phase) * 60_000;
      activeWorkMs += workMs;
      await clock.advanceAsync(workMs);
      const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: stepId, enqueueMissionTask: queue.enqueue };

      if (phase === 0) {
        assert.equal(options.missionTimerResumed, false, "The first slice must not claim it woke from a timer.");
        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", {
          id: mission.id,
          checkpoint: `${stepId}:phase-1`,
          nextAction: `Wake after the short rest and continue ${stepId}.`,
        }, runtime);
        await nativeTool(userId, "CHUCK_TASK_WAIT", {
          delaySeconds: firstSleepSeconds(day),
          checkpoint: `${stepId}:phase-1`,
          nextAction: `Continue ${stepId} after the short rest.`,
        }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        return { text: "The daily checkpoint is saved; continue after the durable rest.", toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], taskWait: request };
      }

      if (phase === 1) {
        assert.equal(options.missionTimerResumed || day % 5 === 0 || day % 7 === 0, true, "The second phase must follow a durable wake or an explicit callback/approval path.");
        await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", {
          id: mission.id,
          checkpoint: `${stepId}:phase-2`,
          nextAction: `Finish the verified work for ${stepId}.`,
        }, runtime);

        if (day % 5 === 0) {
          let request: MissionWaitRequest | undefined;
          await nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", {
            id: mission.id,
            stepId,
            provider: "endurance-provider",
            providerEventId: `endurance-event-${day}`,
            timeoutSeconds: 900,
            checkpoint: `${stepId}:phase-2`,
            nextAction: `Continue ${stepId} when endurance-event-${day} is confirmed.`,
          }, { ...runtime, requestMissionWait: (value) => { request = value; } });
          assert.ok(request);
          return { text: "The provider boundary is parked on its exact callback.", toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_WAIT_EVENT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_WAIT_EVENT"], missionWait: request };
        }

        if (day % 7 === 0) {
          const approval = await createApproval({
            userId,
            toolSlug: "ENDURANCE_APPROVED_ACTION",
            args: { missionId: mission.id, stepId, action: "verify-daily-unit" },
            request: `Approve the verified provider closeout for ${stepId}.`,
            history: [],
            model: "test/endurance",
          });
          throw new ApprovalRequiredError(approval.id, approval.toolSlug, approval.args);
        }

        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_TASK_WAIT", {
          delaySeconds: secondSleepSeconds(day),
          checkpoint: `${stepId}:phase-2`,
          nextAction: `Finish and verify ${stepId} after the second rest.`,
        }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        return { text: "The second checkpoint is saved; continue after the longer rest.", toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], taskWait: request };
      }

      assert.equal(phase, 2);
      await recordTrustedMissionEvidence(userId, mission.id, [{
        id: `endurance-receipt-${day}`,
        kind: "tool_receipt",
        summary: `Verified provider result for ${stepId}.`,
        ref: `endurance:${stepId}`,
        verified: true,
      }], stepId);
      await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", {
        id: mission.id,
        stepId,
        result: `Verified ${stepId} after three active work slices and durable waits.`,
      }, runtime);
      return { text: `Verified ${stepId}.`, toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
    };

    const dependencies = context(queue, runAgent);
    let guard = 0;
    while ((await getMission(userId, mission.id))?.status !== "completed") {
      assert.ok(++guard < 300, "The endurance mission must not spin indefinitely or strand a continuation.");
      let current = await getMission(userId, mission.id);
      assert.ok(current);
      assert.ok(["running", "waiting"].includes(current.status), `Mission stopped unexpectedly: ${current.status} ${current.error ?? ""}`);

      if (current.status === "waiting" && current.waiting?.kind === "timer") {
        const early = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
        assert.equal(early?.status, "waiting", "A future timer cannot be resumed early.");
        const delay = current.waiting.runAt! - clock.now;
        assert.ok(delay > 0);
        timerWakes++;
        await clock.advanceAsync(delay);
      } else if (current.status === "waiting" && current.waiting?.kind === "provider_event") {
        const waiting = current.waiting;
        const eventId = waiting.providerEventId!;
        const expiresAt = waiting.expiresAt!;
        assert.ok(expiresAt - clock.now > 90_000, "The provider callback must arrive before the timeout wake.");
        await clock.advanceAsync(90_000);
        const resumed = await resumeMissionFromProviderEvent(userId, mission.id, waiting.provider!, eventId);
        assert.equal(resumed?.status, "running");
        assert.equal((await resumeMissionFromProviderEvent(userId, mission.id, waiting.provider!, eventId))?.status, "running", "A duplicate callback must be harmless.");
        await reconcileMissionExecution(userId, mission.id, queue.enqueue);
        providerWakes++;
      } else if (current.status === "waiting" && current.waiting?.kind === "approval") {
        const approvalId = current.waiting.key!;
        await clock.advanceAsync(120_000);
        assert.ok(await claimApproval(userId, approvalId));
        const resumed = await resumeMissionTaskAfterApproval(userId, approvalId, queue.enqueue);
        assert.equal(resumed.status, "resumed");
        approvalWakes++;
      }

      current = await getMission(userId, mission.id);
      assert.ok(current);
      const stepId = activeStepId(current);
      const tasks = await listTasksForMission(userId, mission.id);
      const activeTask = tasks.find((task) => task.missionStepId === stepId && !["completed", "cancelled"].includes(task.status));
      assert.ok(activeTask, `Active step ${stepId} must have one durable task.`);
      let dueIndex = queue.deliveries.findIndex((delivery) => delivery.taskId === activeTask.id && delivery.runAt <= clock.now);

      // Simulate an accepted QStash publication whose delivery disappears.
      // The production recovery sweep must notice the overdue publication and
      // republish it from durable task state.
      if (!lostPublicationRecovered && dueIndex >= 0) {
        queue.deliveries.splice(dueIndex, 1);
        await clock.advanceAsync(61_000);
        const report = await recoverMissionsForOwner(userId, queue.enqueue, { now: clock.now });
        assert.ok(report.republished >= 1, `Recovery must republish the lost active delivery: ${JSON.stringify(report)}`);
        lostPublicationRecovered = true;
        dueIndex = queue.deliveries.findIndex((delivery) => delivery.taskId === activeTask.id && delivery.runAt <= clock.now);
      }

      if (dueIndex < 0) {
        const anyDue = queue.deliveries.findIndex((delivery) => delivery.runAt <= clock.now);
        if (anyDue < 0) {
          const nextWake = Math.min(...queue.deliveries.map((delivery) => delivery.runAt));
          assert.ok(Number.isFinite(nextWake), "A live mission must retain a durable future wake.");
          await clock.advanceAsync(Math.max(1, nextWake - clock.now));
          continue;
        }
        dueIndex = anyDue;
      }

      const delivery = queue.deliveries.splice(dueIndex, 1)[0]!;
      const run = await executeDurableTask({ userId, taskId: delivery.taskId }, {
        workerId: `endurance-worker-${++workerInvocations}`,
        execute: (task, signal) => executeTaskSlice(task, signal, dependencies),
      });
      assert.ok(run.task, "Every fake delivery must resolve to a durable task record.");
      assert.equal(run.task.error, undefined, `Worker retried unexpectedly: ${run.task.error ?? "unknown error"}`);
      assert.ok(!["failed", "blocked"].includes(run.task.status), `Worker failed during endurance run: ${run.task.error ?? run.task.nextAction ?? run.task.status}`);
      if (run.task.status === "queued") {
        assert.ok(run.task.runAt && run.task.runAt > clock.now);
        assert.ok(await enqueueTaskWithClaim(userId, run.task.id, run.task.runAt, queue.enqueue));
      }

      if (workerInvocations % 11 === 0 && queue.deliveries.length) queue.duplicate(0);
      if (workerInvocations % 17 === 0) queue.reverse();
      if (workerInvocations % 13 === 0) {
        const report = await recoverMissionsForOwner(userId, queue.enqueue, { now: clock.now });
        assert.equal(report.blocked, 0, `Routine recovery must not block a healthy mission: ${JSON.stringify(report)}`);
      }
    }

    // Late timer/approval publications may still arrive after completion. Run
    // them through the real worker boundary and prove terminal state remains
    // frozen rather than replaying any work.
    let lateDeliveries = 0;
    while (queue.deliveries.length && lateDeliveries++ < 40) {
      const nextWake = Math.min(...queue.deliveries.map((delivery) => delivery.runAt));
      await clock.advanceAsync(Math.max(0, nextWake - clock.now));
      const delivery = queue.deliveries.shift()!;
      const run = await executeDurableTask({ userId, taskId: delivery.taskId }, {
        workerId: `late-delivery-${lateDeliveries}`,
        execute: (task, signal) => executeTaskSlice(task, signal, dependencies),
      });
      assert.ok(!run.task || ["completed", "cancelled"].includes(run.task.status), "A late delivery must not reopen completed mission work.");
    }

    const completed = await getMission(userId, mission.id);
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps.filter((step) => step.status === "completed").length, dayCount);
    assert.equal(completed.verification?.verified, true);
    assert.equal(lostPublicationRecovered, true);
    assert.equal(providerWakes, 4);
    assert.equal(approvalWakes, 3);
    assert.equal(timerWakes, dayCount * 2 - providerWakes - approvalWakes);
    assert.equal(phaseVisits.size, dayCount);
    for (let day = 1; day <= dayCount; day++) assert.deepEqual(phaseVisits.get(`day-${day}`), [0, 1, 2]);
    assert.equal(workerSlices.length, dayCount * 3);
    assert.ok(activeWorkMs >= dayCount * 12 * 60_000, "The harness must execute meaningful active work, not only sleeps.");
    assert.ok(clock.now - initialTime >= (dayCount - 1) * 86400_000, "The virtual clock must cross the full multi-week mission horizon.");
    assert.ok(completed.events.filter((event) => event.type === "checkpointed").length >= dayCount * 2);
    assert.ok(completed.events.some((event) => event.type === "approval_waiting"));
    assert.ok(completed.events.some((event) => event.type === "resumed" && event.provider === "endurance-provider"));
    assert.ok(completed.events.some((event) => event.type === "completed"));
    assert.equal(clock.pendingTimers, 0, "No worker heartbeat, cancellation, budget, or lock timer may leak between durable slices.");
  } finally {
    clock.restore();
  }
});
