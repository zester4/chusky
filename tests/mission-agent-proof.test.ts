import test, { before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { runAgent, invalidateSession, setAgentDependenciesForTests } from "../src/agent.js";
import { createMission, getMission, getTask, initStore, listTasks, startMission, updateTask, type TaskRecord } from "../src/store.js";
import { reconcileMissionExecution } from "../src/missionScheduler.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { executeTaskSlice } from "../src/taskSlice.js";
import { captureMissionSliceState, missionWorkerToolAllowlist, MISSION_WORKER_CONTROL_TOOLS } from "../src/missionWorker.js";
import { settleMissionSlice } from "../src/missionSlice.js";
import { MissionFakeQStash } from "./helpers/missionKernelHarness.js";
import { nativeTool } from "../src/nativeTools.js";

before(async () => { await initStore({ memoryOnly: true }); });

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
