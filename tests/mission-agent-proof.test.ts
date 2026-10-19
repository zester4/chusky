import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { runAgent, invalidateSession, setAgentDependenciesForTests } from "../src/agent.js";
import { createMission, getMission, getTask, initStore, listTasks, startMission, updateTask, type TaskRecord } from "../src/store.js";
import { reconcileMissionExecution } from "../src/missionScheduler.js";
import { recoverMissionsForOwner } from "../src/missionRecovery.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { executeTaskSlice } from "../src/taskSlice.js";
import { captureMissionSliceState, missionWorkerToolAllowlist, MISSION_WORKER_CONTROL_TOOLS } from "../src/missionWorker.js";
import { settleMissionSlice } from "../src/missionSlice.js";
import { MissionFakeQStash } from "./helpers/missionKernelHarness.js";
import { nativeTool } from "../src/nativeTools.js";

const originalRedisUrl = config.redisUrl;
before(async () => {
  // Agent context can use the hot-memory cache independently of the primary
  // store. Keep this mocked-provider proof fully local even when .env has Redis.
  config.redisUrl = "";
  await initStore({ memoryOnly: true });
});
after(() => { config.redisUrl = originalRedisUrl; });

function completion(content: string | null, call?: { id: string; name: string; args: object }) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
    role: "assistant", content, ...(call ? { tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}),
  } }] }), { headers: { "content-type": "application/json" } });
}

/** Script the inference/transport boundary, not native dispatch or settlement. */
async function scriptedAgent(task: TaskRecord, queue: MissionFakeQStash, script: (round: number) => Response, testOptions: { omitToolAllow?: boolean; capturedTools?: string[] } = {}) {
  const originalFetch = globalThis.fetch;
  const originalVectorUrl = config.upstashVectorRestUrl;
  const originalVectorToken = config.upstashVectorRestToken;
  const session = { sessionId: `proof-${task.id}`, tools: async () => [], execute: async () => { throw new Error("Unexpected provider dispatch"); } };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });
  invalidateSession(task.userId);
  config.upstashVectorRestUrl = "";
  config.upstashVectorRestToken = "";
  let round = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      if (testOptions.capturedTools) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function?: { name?: string } }> };
        testOptions.capturedTools.push(...(body.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean));
      }
      return script(round++);
    }
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await runAgent(task.userId, `Execute and verify mission ${task.missionId} step ${task.missionStepId}.`, [], "test/model", undefined, undefined, undefined, undefined, undefined, {
      taskId: task.id, missionId: task.missionId, missionStepId: task.missionStepId,
      ...(testOptions.omitToolAllow ? {} : { toolAllow: missionWorkerToolAllowlist([]) }),
      enqueueMissionTask: queue.enqueue,
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.upstashVectorRestUrl = originalVectorUrl;
    config.upstashVectorRestToken = originalVectorToken;
  }
}

test("every mission model request retains all lifecycle controls after routing", async () => {
  const userId = 981000;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, { title: "Lifecycle tool surface", objective: "Analyze the sales CSV", definitionOfDone: "The analysis is verified", steps: [{ id: "unit", title: "Analyze CSV", objective: "Analyze the sales CSV" }] });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
  assert.ok(task);
  const capturedTools: string[] = [];
  await scriptedAgent(task, queue, () => completion("The step remains in progress."), { omitToolAllow: true, capturedTools });
  for (const control of MISSION_WORKER_CONTROL_TOOLS) assert.ok(capturedTools.includes(control), `missing mission lifecycle tool ${control}`);
});
test("real agent dispatch advances a three-step mission through durable handoffs", async () => {
  const userId = 981001;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, { title: "Agent proof", objective: "Complete three verified internal units", definitionOfDone: "Every unit completed", steps: Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`, title: `Unit ${index}`, objective: "Complete the bounded internal unit", dependsOn: index ? [`s${index - 1}`] : [] })) });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  for (let slice = 0; slice < 3; slice++) {
    const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
    assert.ok(task, "Every dependency-ready step must have a task.");
    await updateTask(userId, task.id, { runAt: Date.now() - 1 });
    const execution = await executeDurableTask({ userId, taskId: task.id }, {
      workerId: `proof-worker-${slice}`, execute: async (claimed) => {
        const mission = await getMission(userId, created.id);
        assert.ok(mission);
        const before = captureMissionSliceState(claimed, mission);
        const result = await scriptedAgent(claimed, queue, (round) => round === 0
          ? completion(null, { id: `complete-${slice}`, name: "CHUCK_MISSION_STEP_COMPLETE", args: { id: mission.id, stepId: claimed.missionStepId, result: "Internal unit verified." } })
          : completion("The internal unit is verified and its persisted step is complete."));
        assert.deepEqual(result.toolOutcomes, [{ callId: `complete-${slice}`, toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded", dispatched: true }]);
        return settleMissionSlice({ task: claimed, mission, before, result, currentMissionStep: mission.steps.find((step) => step.id === claimed.missionStepId), enqueue: queue.enqueue });
      },
    });
    assert.equal(execution.claimed, true);
    assert.equal((await getTask(userId, task.id))?.status, "completed");
  }
  assert.equal((await getMission(userId, created.id))?.status, "completed");
  assert.equal(queue.published.length, 3);
});

test("real agent dispatch preserves the owning mission step for a durable timer", async () => {
  const userId = 981004;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, {
    title: "Agent timer ownership",
    objective: "Persist one checkpoint and wait for the same mission step",
    definitionOfDone: "The timer request is accepted for the active step",
    steps: [{ id: "wait", title: "Wait", objective: "Persist the checkpoint and wait" }],
  });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
  assert.ok(task);

  const result = await scriptedAgent(task, queue, () => completion(null, {
    id: "wait-1",
    name: "CHUCK_TASK_WAIT",
    args: { delaySeconds: 60, checkpoint: "stage-1-complete", nextAction: "Verify stage 1 after wake" },
  }));

  assert.equal(result.taskWait?.checkpoint, "stage-1-complete");
  assert.equal(result.taskWait?.nextAction, "Verify stage 1 after wake");
  assert.ok(typeof result.taskWait?.runAt === "number" && result.taskWait.runAt > Date.now());
  assert.deepEqual(result.toolOutcomes, [{ callId: "wait-1", toolSlug: "CHUCK_TASK_WAIT", status: "succeeded", dispatched: true }]);
});

test("one mocked mission wakes from a durable timer and finishes the same step", async () => {
  const userId = 981006;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, {
    title: "Timer continuation proof",
    objective: "Park work, wake, and verify the result",
    definitionOfDone: "The post-wake verification is complete",
    steps: [{ id: "wait-and-verify", title: "Wait and verify", objective: "Save a checkpoint, wait, then verify the result." }],
  });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  const initialTask = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
  assert.ok(initialTask);

  let calls = 0;
  const fakeRunAgent = (async (userIdFromRun: number, ...args: unknown[]) => {
    const options = args.at(-1) as { taskId?: string; missionId?: string; missionStepId?: string; enqueueMissionTask?: typeof queue.enqueue; missionTimerResumed?: boolean };
    let taskWait: { runAt: number; checkpoint: string; nextAction: string; reason?: string } | undefined;
    const runtime = {
      taskId: options.taskId,
      missionId: options.missionId,
      missionStepId: options.missionStepId,
      enqueueMissionTask: options.enqueueMissionTask ?? queue.enqueue,
      requestTaskWait: (request: { runAt: number; checkpoint: string; nextAction: string; reason?: string }) => { taskWait = request; },
      missionTimerResumed: options.missionTimerResumed,
    };
    if (calls++ === 0) {
      await nativeTool(userIdFromRun, "CHUCK_MISSION_CHECKPOINT", {
        id: created.id,
        checkpoint: "The pre-wake state was saved.",
        nextAction: "After the timer wakes, verify the saved state.",
      }, runtime);
      await nativeTool(userIdFromRun, "CHUCK_TASK_WAIT", {
        delaySeconds: 60,
        checkpoint: "The work is parked with its pre-wake state saved.",
        nextAction: "Verify the saved state after the timer wakes.",
        reason: "The bounded fixture wait is intentional.",
      }, runtime);
      assert.ok(taskWait, "The mocked CHUCK_TASK_WAIT call must return a durable continuation request.");
      return {
        text: "The work is parked until the durable timer wakes.",
        toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"],
        toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"],
        toolOutcomes: [],
        taskWait,
      };
    }
    assert.equal(options.missionTimerResumed, true, "The second turn must be marked as a post-wake continuation.");
    await nativeTool(userIdFromRun, "CHUCK_MISSION_STEP_COMPLETE", {
      id: created.id,
      stepId: "wait-and-verify",
      result: "The saved state was verified after the timer wake.",
    }, runtime);
    return {
      text: "The saved state was verified after the timer wake.",
      toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"],
      toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"],
      toolOutcomes: [],
    };
  }) as unknown as typeof runAgent;

  const execute = (task: TaskRecord, signal?: AbortSignal) => executeTaskSlice(task, signal, {
    attempt: 0,
    sdkTaskMessage: async () => "",
    sdkTaskSkillInstructions: async () => undefined,
    sdkDurationSeconds: () => undefined,
    withUserLock: async (_ownerId, _signal, work) => work(),
    sendMessage: async () => undefined,
    runAgent: fakeRunAgent,
    enqueueMissionTask: queue.enqueue,
  });

  const firstRun = await executeDurableTask({ userId, taskId: initialTask.id }, { workerId: "timer-proof-worker-1", execute });
  assert.equal(firstRun.claimed, true);
  assert.equal(firstRun.task?.status, "queued");
  const parked = await getMission(userId, created.id);
  assert.equal(parked?.status, "waiting", JSON.stringify({ firstRun, parked, calls }));
  assert.equal(parked?.waiting?.kind, "timer");
  assert.equal(parked?.waiting?.stepId, "wait-and-verify");
  const runAt = parked?.waiting?.runAt;
  assert.ok(runAt);

  const originalNow = Date.now;
  try {
    Date.now = () => runAt + 1;
    const recovery = await recoverMissionsForOwner(userId, queue.enqueue);
    assert.equal(recovery.timerWakes, 1);
    assert.equal((await getMission(userId, created.id))?.status, "running");

    const resumedTask = await getTask(userId, initialTask.id);
    assert.ok(resumedTask);
    const secondRun = await executeDurableTask({ userId, taskId: initialTask.id }, { workerId: "timer-proof-worker-2", execute });
    assert.equal(secondRun.claimed, true);
    assert.equal(secondRun.task?.status, "completed");
    assert.equal((await getMission(userId, created.id))?.status, "completed");
    assert.equal((await getMission(userId, created.id))?.steps.find((step) => step.id === "wait-and-verify")?.status, "completed");
    assert.equal(calls, 2);
    assert.equal(resumedTask.id, initialTask.id, "The wake must resume the existing durable task, not create a replacement identity.");
  } finally {
    Date.now = originalNow;
  }
});

test("a no-live-model golden mission advances all 13 relationship stages step by step", async () => {
  const userId = 981005;
  const queue = new MissionFakeQStash();
  const stages = [
    ["goal", "Define the business outcome"],
    ["signals", "Record the relevant change signals"],
    ["list", "Build the working people list"],
    ["shortlist", "Select the strongest fits"],
    ["enrichment", "Add bounded contact and company details"],
    ["saved-work", "Save the working list"],
    ["next-action", "Persist the next action"],
    ["research", "Prepare person-specific research"],
    ["outreach", "Prepare and record approved outreach"],
    ["meeting", "Record the meeting outcome"],
    ["follow-up", "Persist the agreed follow-up"],
    ["client", "Check the customer relationship state"],
    ["feedback", "Record customer feedback and attention"],
  ] as const;
  const created = await createMission(userId, {
    title: "Golden relationship mission",
    objective: "Complete the full relationship lifecycle using deterministic local fixtures.",
    definitionOfDone: "All 13 stages have a durable result and the mission is completed.",
    budget: { maxDurationSeconds: 3_600, maxSteps: 20, maxToolCalls: 100, maxCost: 1 },
    steps: stages.map(([id, objective], index) => ({
      id,
      title: id,
      objective,
      dependsOn: index ? [stages[index - 1]![0]] : [],
    })),
  });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);

  let modelCalls = 0;
  const fakeRunAgent = (async (ownerId: number, ...args: unknown[]) => {
    const options = args.at(-1) as { taskId?: string; missionId?: string; missionStepId?: string; enqueueMissionTask?: typeof queue.enqueue };
    const stage = stages.find(([id]) => id === options.missionStepId);
    assert.ok(stage, `the worker must receive one of the typed mission stages: ${options.missionStepId}`);
    const runtime = { taskId: options.taskId, missionId: options.missionId, missionStepId: options.missionStepId, enqueueMissionTask: options.enqueueMissionTask ?? queue.enqueue };
    modelCalls += 1;
    await nativeTool(ownerId, "CHUCK_MISSION_CHECKPOINT", {
      id: created.id,
      checkpoint: `Mock provider receipt: ${stage[0]} stage completed locally.`,
      nextAction: `Complete the ${stage[0]} stage after its local receipt is saved.`,
    }, runtime);
    await nativeTool(ownerId, "CHUCK_MISSION_STEP_COMPLETE", {
      id: created.id,
      stepId: stage[0],
      result: `Local fixture verified the ${stage[0]} stage without a live model or provider.`,
    }, runtime);
    return {
      text: `The ${stage[0]} stage is durably complete.`,
      toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
      toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
      toolOutcomes: [
        { callId: `checkpoint-${stage[0]}`, toolSlug: "CHUCK_MISSION_CHECKPOINT", status: "succeeded" as const, dispatched: true },
        { callId: `complete-${stage[0]}`, toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded" as const, dispatched: true },
      ],
    };
  }) as unknown as typeof runAgent;

  for (let index = 0; index < stages.length; index++) {
    const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
    assert.ok(task, `stage ${index + 1} should be queued after the prior stage settles`);
    await updateTask(userId, task.id, { runAt: Date.now() - 1 });
    const execution = await executeDurableTask({ userId, taskId: task.id }, {
      workerId: `golden-relationship-worker-${index}`,
      execute: (claimed, signal) => executeTaskSlice(claimed, signal, {
        attempt: 0,
        sdkTaskMessage: async () => "",
        sdkTaskSkillInstructions: async () => undefined,
        sdkDurationSeconds: () => undefined,
        withUserLock: async (_ownerId, _signal, work) => work(),
        sendMessage: async () => undefined,
        runAgent: fakeRunAgent,
        enqueueMissionTask: queue.enqueue,
      }),
    });
    assert.equal(execution.claimed, true);
    assert.equal((await getTask(userId, task.id))?.status, "completed");
  }

  const finished = await getMission(userId, created.id);
  assert.equal(modelCalls, stages.length);
  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.steps.map((step) => step.id), stages.map(([id]) => id));
  assert.ok(finished?.steps.every((step) => step.status === "completed"));
  assert.ok(finished?.steps.every((step) => /Local fixture verified/.test(step.result ?? "")));
  assert.equal(queue.published.length, stages.length);
});

test("a prose-only real agent is not promoted to mission completion", async () => {
  const userId = 981002;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, { title: "No fabricated completion", objective: "Persist actual work", definitionOfDone: "Unit verified", steps: [{ id: "unit", title: "Unit", objective: "Do actual work" }] });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id)!;
  const execution = await executeDurableTask({ userId, taskId: task.id }, { workerId: "prose-worker", execute: async (claimed) => {
    const mission = (await getMission(userId, created.id))!;
    const before = captureMissionSliceState(claimed, mission);
    const result = await scriptedAgent(claimed, queue, () => completion("Everything is complete."));
    return settleMissionSlice({ task: claimed, mission, before, result, enqueue: queue.enqueue });
  } });
  assert.equal(execution.task?.status, "queued");
  assert.notEqual((await getMission(userId, created.id))?.status, "completed");
});

test("a durable evidence turn receives one lifecycle nudge and closes the active step", async () => {
  const userId = 981003;
  const queue = new MissionFakeQStash();
  const created = await createMission(userId, { title: "Lifecycle nudge", objective: "Persist and close one internal unit", definitionOfDone: "The internal unit is complete", steps: [{ id: "unit", title: "Unit", objective: "Persist the unit evidence and complete it" }] });
  await startMission(userId, created.id);
  await reconcileMissionExecution(userId, created.id, queue.enqueue);
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === created.id && candidate.status === "queued");
  assert.ok(task);
  let calls = 0;
  const fakeRunAgent = (async (userIdFromRun: number, ...args: unknown[]) => {
    const options = args.at(-1) as { taskId?: string; missionId?: string };
    const runtime = { taskId: options.taskId, missionId: options.missionId, enqueueMissionTask: queue.enqueue };
    calls += 1;
    if (calls === 1) {
      await nativeTool(userIdFromRun, "CHUCK_MISSION_EVIDENCE", { id: created.id, stepId: "unit", evidence: [{ kind: "assertion", summary: "The internal unit was persisted.", verified: false }] }, runtime);
      return { text: "Evidence persisted.", toolsUsed: ["CHUCK_MISSION_EVIDENCE"], toolsSucceeded: ["CHUCK_MISSION_EVIDENCE"], toolOutcomes: [{ callId: "evidence-1", toolSlug: "CHUCK_MISSION_EVIDENCE", status: "succeeded" as const, dispatched: true }] };
    }
    await nativeTool(userIdFromRun, "CHUCK_MISSION_STEP_COMPLETE", { id: created.id, stepId: "unit", result: "The persisted internal unit is complete." }, runtime);
    return { text: "The step is complete.", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"], toolOutcomes: [{ callId: "complete-1", toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded" as const, dispatched: true }] };
  }) as unknown as typeof runAgent;
  const execution = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "lifecycle-nudge-worker",
    execute: (claimed, signal) => executeTaskSlice(claimed, signal, {
      attempt: 0,
      sdkTaskMessage: async () => "",
      sdkTaskSkillInstructions: async () => undefined,
      sdkDurationSeconds: () => undefined,
      withUserLock: async (_ownerId, _signal, work) => work(),
      sendMessage: async () => undefined,
      runAgent: fakeRunAgent,
      enqueueMissionTask: queue.enqueue,
    }),
  });
  assert.equal(execution.claimed, true);
  assert.equal(calls, 2, "The worker should allow one bounded lifecycle closeout turn.");
  assert.equal((await getMission(userId, created.id))?.status, "completed");
});
