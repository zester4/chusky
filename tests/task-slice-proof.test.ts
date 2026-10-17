import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { executeTaskSlice, type TaskSliceContext } from "../src/taskSlice.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { nativeTool } from "../src/nativeTools.js";
import { acquireUserLock, claimApproval, createApproval, createMission, getMission, getTask, initStore, listTasks, recordTrustedMissionEvidence, releaseUserLock, resumeMissionFromProviderEvent, startMission, updateMission, waitMission } from "../src/store.js";
import { reconcileMissionExecution, replanMissionAndSchedule, resumeMissionAndSchedule } from "../src/missionScheduler.js";
import { resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import { ApprovalRequiredError } from "../src/agent.js";
import type { TaskWaitRequest, MissionWaitRequest } from "../src/types.js";
import { MissionFakeClock, MissionFakeQStash } from "./helpers/missionKernelHarness.js";
import { config } from "../src/config.js";

const originalJevMode = config.jevMode;

before(async () => {
  // This proof harness owns the model and provider fakes. Do not open a real
  // Jev socket before the fake-clock suites; an idle live socket can outlive
  // the first test and emit after the later clock teardown. Jev request
  // cancellation is covered independently by injected-client routing tests.
  config.jevMode = "off";
  await initStore({ memoryOnly: true });
});

after(() => { config.jevMode = originalJevMode; });

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

test("legacy zero-cost missions block before the worker invokes the model", async () => {
  const userId = 982000;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, {
    title: "Legacy zero-cost mission",
    objective: "Exercise the worker defense-in-depth guard.",
    definitionOfDone: "The invalid mission is blocked before inference.",
    budget: { maxCost: 1 },
  });
  await updateMission(userId, mission.id, { budget: { ...mission.budget, maxCost: 0 } });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id);
  assert.ok(task);
  let modelCalls = 0;
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "zero-cost-defense-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, context(queue, async () => { modelCalls++; return { text: "must not run", toolsUsed: [], toolsSucceeded: [] }; })) });
  assert.equal(modelCalls, 0);
  assert.equal(run.task?.status, "blocked");
  assert.match(run.task?.nextAction ?? "", /positive model-execution budget/i);
  assert.equal((await getMission(userId, mission.id))?.status, "blocked");
});

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

test("production mission lifecycle starts, sleeps, wakes, and continues the same task", async () => {
  const userId = 982006;
  const clock = new MissionFakeClock();
  clock.install();
  try {
    const queue = new MissionFakeQStash();
    const mission = await createMission(userId, {
      title: "Timer continuation proof",
      objective: "Persist a timer, wake, and verify the post-wake action",
      definitionOfDone: "The post-wake verification is persisted as the completed step result",
      steps: [{ id: "sleep-check", title: "Sleep and verify", objective: "Wait for the bounded timer, then verify the resumed state" }],
    });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);
    const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "sleep-check");
    assert.ok(task);
    assert.ok(queue.deliveries.some((delivery) => delivery.taskId === task.id && delivery.runAt <= clock.now));

    let modelCalls = 0;
    let firstTaskId: string | undefined;
    const dependencies = context(queue, async (...args) => {
      modelCalls++;
      const options = args[9]!;
      firstTaskId ??= options.taskId;
      assert.equal(options.taskId, task.id);
      assert.equal(options.missionId, mission.id);
      assert.equal(options.missionStepId, "sleep-check");
      const runtime = {
        taskId: options.taskId,
        missionId: mission.id,
        missionStepId: "sleep-check",
        enqueueMissionTask: queue.enqueue,
      };

      if (modelCalls === 1) {
        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_TASK_WAIT", {
          delaySeconds: 60,
          checkpoint: "Pre-wake state verified",
          nextAction: "Verify the resumed state and complete the step",
        }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        return {
          text: "The state is verified; I will continue after the timer.",
          toolsUsed: ["CHUCK_TASK_WAIT"],
          toolsSucceeded: ["CHUCK_TASK_WAIT"],
          taskWait: request,
        };
      }

      assert.equal(options.missionTimerResumed, true);
      await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", {
        id: mission.id,
        checkpoint: "Post-wake state verified",
        nextAction: "Complete the active step",
      }, runtime);
      await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", {
        id: mission.id,
        stepId: "sleep-check",
        result: "Post-wake verification completed",
      }, runtime);
      return {
        text: "The timer completed and the resumed state is verified.",
        toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
        toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
      };
    });

    const initialDelivery = queue.deliveries.findIndex((delivery) => delivery.taskId === task.id && delivery.runAt <= clock.now);
    queue.deliveries.splice(initialDelivery, 1);
    const firstRun = await executeDurableTask({ userId, taskId: task.id }, {
      workerId: "timer-lifecycle-start-worker",
      execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
    });
    assert.equal(firstRun.task?.id, task.id);
    assert.equal(firstRun.task?.status, "queued");
    assert.equal(firstRun.task?.runAt, clock.now + 60000);
    assert.match(firstRun.task?.nextAction ?? "", /After the durable timer wakes.*Do not call CHUCK_TASK_WAIT again/);
    assert.equal(modelCalls, 1);
    assert.equal((await getMission(userId, mission.id))?.status, "waiting");
    assert.equal((await getMission(userId, mission.id))?.waiting?.kind, "timer");
    assert.equal((await getMission(userId, mission.id))?.waiting?.runAt, clock.now + 60000);
    await queue.enqueue(userId, task.id, firstRun.task!.runAt!);

    const early = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
    assert.equal(early?.status, "waiting");
    assert.equal(modelCalls, 1, "A future timer must not invoke the model early");

    const wakeAt = firstRun.task!.runAt!;
    clock.advance(wakeAt - clock.now);
    const resumed = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.waiting, undefined);
    assert.ok(resumed?.events.some((event) => event.type === "resumed" && event.metadata?.timerRunAt === wakeAt));

    const wakeDelivery = queue.deliveries.findIndex((delivery) => delivery.taskId === task.id && delivery.runAt <= clock.now);
    assert.ok(wakeDelivery >= 0, "The resumed mission must publish a due continuation for the same task");
    queue.deliveries.splice(wakeDelivery, 1);
    const continued = await executeDurableTask({ userId, taskId: task.id }, {
      workerId: "timer-lifecycle-wake-worker",
      execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
    });
    assert.equal(firstTaskId, task.id);
    assert.equal(modelCalls, 2);
    assert.equal(continued.task?.id, task.id);
    assert.equal(continued.task?.status, "completed", continued.task?.error ?? JSON.stringify(continued.task?.events.at(-1)));
    const completed = await getMission(userId, mission.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.steps.find((step) => step.id === "sleep-check")?.result, "Post-wake verification completed");
  } finally {
    clock.restore();
  }
});

test("production mission repeats sleep and wake across steps until completion", async () => {
  const userId = 982007;
  const clock = new MissionFakeClock();
  clock.install();
  try {
    const queue = new MissionFakeQStash();
    const mission = await createMission(userId, {
      title: "Repeated timer lifecycle proof",
      objective: "Sleep and wake twice, completing one verified step after each wake",
      definitionOfDone: "Both timer-backed steps are completed after their post-wake verification",
      steps: [
        { id: "first-wait", title: "First wait", objective: "Wait, wake, and verify the first state" },
        { id: "second-wait", title: "Second wait", objective: "Wait again, wake, and verify the final state", dependsOn: ["first-wait"] },
      ],
    });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);
    const firstTask = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "first-wait");
    assert.ok(firstTask);

    let modelCalls = 0;
    const dependencies = context(queue, async (...args) => {
      modelCalls++;
      const options = args[9]!;
      const stepId = options.missionStepId!;
      const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: stepId, enqueueMissionTask: queue.enqueue };
      const waitRequest = async (checkpoint: string, nextAction: string) => {
        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_TASK_WAIT", { delaySeconds: 60, checkpoint, nextAction }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        return { text: "The current state is verified; I will continue after the timer.", toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], taskWait: request };
      };
      const completeAfterWake = async (result: string) => {
        assert.equal(options.missionTimerResumed, true);
        await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", { id: mission.id, checkpoint: `Verified ${stepId} after wake`, nextAction: `Complete ${stepId}` }, runtime);
        await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId, result }, runtime);
        return { text: result, toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"] };
      };

      assert.equal(options.missionTimerResumed, modelCalls % 2 === 0);
      if (!options.missionTimerResumed) return waitRequest(`Before wake ${stepId}`, `Resume ${stepId} after the timer`);
      return completeAfterWake(`Verified ${stepId} after its timer`);
    });

    const runTimerCycle = async (taskId: string, expectedStepId: string) => {
      const due = queue.deliveries.findIndex((delivery) => delivery.taskId === taskId && delivery.runAt <= clock.now);
      assert.ok(due >= 0, `Expected a due delivery for ${expectedStepId}`);
      queue.deliveries.splice(due, 1);
      const sleeping = await executeDurableTask({ userId, taskId }, {
        workerId: `${expectedStepId}-sleep-worker`,
        execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
      });
      assert.equal(sleeping.task?.id, taskId);
      assert.equal(sleeping.task?.status, "queued");
      assert.equal((await getMission(userId, mission.id))?.status, "waiting");
      assert.equal((await getMission(userId, mission.id))?.waiting?.kind, "timer");
      await queue.enqueue(userId, taskId, sleeping.task!.runAt!);

      const early = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
      assert.equal(early?.status, "waiting");
      const wakeAt = sleeping.task!.runAt!;
      clock.advance(wakeAt - clock.now);
      const resumed = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
      assert.equal(resumed?.status, "running");
      assert.ok(resumed?.events.some((event) => event.type === "resumed" && event.metadata?.timerRunAt === wakeAt));

      const wake = queue.deliveries.findIndex((delivery) => delivery.taskId === taskId && delivery.runAt <= clock.now);
      assert.ok(wake >= 0, `Expected the resumed ${expectedStepId} task to be published`);
      queue.deliveries.splice(wake, 1);
      const completed = await executeDurableTask({ userId, taskId }, {
        workerId: `${expectedStepId}-wake-worker`,
        execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
      });
      assert.equal(completed.task?.id, taskId);
      assert.equal(completed.task?.status, "completed");
    };

    await runTimerCycle(firstTask.id, "first-wait");
    const secondTask = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "second-wait");
    assert.ok(secondTask);
    await runTimerCycle(secondTask.id, "second-wait");

    assert.equal(modelCalls, 4);
    const completed = await getMission(userId, mission.id);
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.steps.map((step) => step.status), ["completed", "completed"]);
  } finally {
    clock.restore();
  }
});

test("production mission handles staged 5-minute, 30-minute, and 1-hour wakes", async () => {
  const userId = 982008;
  const clock = new MissionFakeClock();
  clock.install();
  try {
    const queue = new MissionFakeQStash();
    const stages = [
      { id: "five-minute", title: "Five-minute wait", delaySeconds: 5 * 60 },
      { id: "thirty-minute", title: "Thirty-minute wait", delaySeconds: 30 * 60 },
      { id: "one-hour", title: "One-hour wait", delaySeconds: 60 * 60 },
    ];
    const mission = await createMission(userId, {
      title: "Staged long timer proof",
      objective: "Sleep and wake after five minutes, thirty minutes, and one hour",
      definitionOfDone: "All three staged waits wake on time and their steps complete",
      steps: stages.map((stage, index) => ({
        id: stage.id,
        title: stage.title,
        objective: `Wait ${stage.delaySeconds} seconds, wake, and verify the staged state`,
        ...(index ? { dependsOn: [stages[index - 1].id] } : {}),
      })),
    });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);

    let modelCalls = 0;
    const dependencies = context(queue, async (...args) => {
      modelCalls++;
      const options = args[9]!;
      const stage = stages.find((candidate) => candidate.id === options.missionStepId);
      assert.ok(stage);
      const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: stage.id, enqueueMissionTask: queue.enqueue };
      if (!options.missionTimerResumed) {
        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_TASK_WAIT", {
          delaySeconds: stage.delaySeconds,
          checkpoint: `${stage.title} state saved before sleep`,
          nextAction: `Verify ${stage.title} after wake`,
        }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        return { text: `${stage.title} is sleeping until its durable timer wakes.`, toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], taskWait: request };
      }
      await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", { id: mission.id, checkpoint: `${stage.title} state verified after wake`, nextAction: `Complete ${stage.title}` }, runtime);
      await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: stage.id, result: `${stage.title} completed after wake` }, runtime);
      return { text: `${stage.title} completed after wake.`, toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"] };
    });

    for (const stage of stages) {
      const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === stage.id);
      assert.ok(task, `Expected a task for ${stage.id}`);
      const due = queue.deliveries.findIndex((delivery) => delivery.taskId === task.id && delivery.runAt <= clock.now);
      assert.ok(due >= 0, `Expected ${stage.id} to start immediately`);
      queue.deliveries.splice(due, 1);
      const sleeping = await executeDurableTask({ userId, taskId: task.id }, {
        workerId: `${stage.id}-sleep-worker`,
        execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
      });
      assert.equal(sleeping.task?.status, "queued");
      const wakeAt = clock.now + stage.delaySeconds * 1000;
      assert.equal(sleeping.task?.runAt, wakeAt);
      assert.equal((await getMission(userId, mission.id))?.waiting?.runAt, wakeAt);
      await queue.enqueue(userId, task.id, wakeAt);

      assert.equal((await resumeMissionAndSchedule(userId, mission.id, queue.enqueue))?.status, "waiting");
      clock.advance(stage.delaySeconds * 1000);
      const resumed = await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
      assert.equal(resumed?.status, "running");
      const wakeEvent = resumed?.events.find((event) => event.type === "resumed" && event.metadata?.timerRunAt === wakeAt);
      assert.equal(wakeEvent?.metadata?.scheduledDelayMs, stage.delaySeconds * 1000);

      const wake = queue.deliveries.findIndex((delivery) => delivery.taskId === task.id && delivery.runAt <= clock.now);
      assert.ok(wake >= 0, `Expected ${stage.id} to publish its wake continuation`);
      queue.deliveries.splice(wake, 1);
      const completed = await executeDurableTask({ userId, taskId: task.id }, {
        workerId: `${stage.id}-wake-worker`,
        execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
      });
      assert.equal(completed.task?.status, "completed");
    }

    assert.equal(modelCalls, stages.length * 2);
    assert.equal(clock.now, Date.UTC(2026, 0, 1) + (5 + 30 + 60) * 60 * 1000);
    assert.equal((await getMission(userId, mission.id))?.status, "completed");
  } finally {
    clock.restore();
  }
});

test("a completed step cannot schedule a timer for its successor", async () => {
  const userId = 982020;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, {
    title: "Step transition before wait",
    objective: "Complete initialization, wait, then verify recovery",
    definitionOfDone: "The post-wake step is completed",
    steps: [
      { id: "initialize", title: "Initialize", objective: "Persist the initial checkpoint" },
      { id: "resume-check", title: "Resume check", objective: "Verify state after the timer", dependsOn: ["initialize"] },
    ],
  });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "initialize")!;
  const runAt = Date.now() + 120_000;
  let rejectedCrossStepWait = false;
  const dependencies = context(queue, async () => {
    const runtime = { taskId: task.id, missionId: mission.id, missionStepId: "initialize", enqueueMissionTask: queue.enqueue };
    await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "initialize", result: "Initial checkpoint persisted" }, runtime);
    try {
      await nativeTool(userId, "CHUCK_TASK_WAIT", { runAt: new Date(runAt).toISOString(), checkpoint: "Initialization verified", nextAction: "Continue the plan after the timer" }, { ...runtime, requestTaskWait: () => { throw new Error("A completed step must not capture its successor's timer."); } });
    } catch (error) {
      rejectedCrossStepWait = error instanceof Error && /active running step/i.test(error.message);
    }
    return { text: "Initialization completed; the successor owns its timer.", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE", "CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
  });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "step-transition-wait-worker", execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies) });
  const persisted = await getMission(userId, mission.id);
  assert.equal(rejectedCrossStepWait, true);
  assert.equal(run.task?.status, "completed");
  assert.equal(persisted?.status, "running");
  assert.equal(persisted?.waiting, undefined);
  assert.equal(persisted?.steps.find((step) => step.id === "initialize")?.status, "completed");
  assert.equal(persisted?.steps.find((step) => step.id === "resume-check")?.status, "running");
});

test("a completed step task cannot execute the successor under the old step lease", async () => {
  const userId = 982021;
  const queue = new MissionFakeQStash();
  const mission = await createMission(userId, {
    title: "Stale step task handoff",
    objective: "Complete initialization then continue the next step",
    definitionOfDone: "Both steps complete",
    steps: [
      { id: "initialize", title: "Initialize", objective: "Persist initial checkpoint" },
      { id: "resume-check", title: "Resume check", objective: "Verify resumed state", dependsOn: ["initialize"] },
    ],
  });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, queue.enqueue);
  const initializeTask = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "initialize")!;
  await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "initialize", result: "Initialization verified" }, {
    taskId: initializeTask.id,
    missionId: mission.id,
    missionStepId: "initialize",
    enqueueMissionTask: queue.enqueue,
  });
  let modelCalls = 0;
  const dependencies = context(queue, async () => {
    modelCalls++;
    return { text: "Incorrectly executed the successor", toolsUsed: [], toolsSucceeded: [] };
  });
  const run = await executeDurableTask({ userId, taskId: initializeTask.id }, {
    workerId: "stale-step-handoff-worker",
    execute: (claimed, signal) => executeTaskSlice(claimed, signal, dependencies),
  });
  assert.equal(modelCalls, 0, "The completed task must hand off without invoking the model for another step.");
  assert.equal(run.task?.status, "completed");
  assert.equal(run.task?.missionStepId, "initialize");
  assert.ok((await listTasks(userId)).some((candidate) => candidate.missionId === mission.id && candidate.missionStepId === "resume-check"));
  assert.equal((await getMission(userId, mission.id))?.steps.find((step) => step.id === "resume-check")?.status, "running");
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
        const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: options.missionStepId, enqueueMissionTask: queue.enqueue };
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
