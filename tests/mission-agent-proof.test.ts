import test, { before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { runAgent, invalidateSession, setAgentDependenciesForTests } from "../src/agent.js";
import { createMission, getMission, getTask, initStore, listTasks, startMission, updateTask, type TaskRecord } from "../src/store.js";
import { reconcileMissionExecution } from "../src/missionScheduler.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { captureMissionSliceState, missionWorkerToolAllowlist } from "../src/missionWorker.js";
import { settleMissionSlice } from "../src/missionSlice.js";
import { MissionFakeQStash } from "./helpers/missionKernelHarness.js";

before(async () => { await initStore({ memoryOnly: true }); });

function completion(content: string | null, call?: { id: string; name: string; args: object }) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
    role: "assistant", content, ...(call ? { tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}),
  } }] }), { headers: { "content-type": "application/json" } });
}

/** Script the inference/transport boundary, not native dispatch or settlement. */
async function scriptedAgent(task: TaskRecord, queue: MissionFakeQStash, script: (round: number) => Response) {
  const originalFetch = globalThis.fetch;
  const originalVectorUrl = config.upstashVectorRestUrl;
  const originalVectorToken = config.upstashVectorRestToken;
  const session = { sessionId: `proof-${task.id}`, tools: async () => [], execute: async () => { throw new Error("Unexpected provider dispatch"); } };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });
  invalidateSession(task.userId);
  config.upstashVectorRestUrl = "";
  config.upstashVectorRestToken = "";
  let round = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/chat/completions")) return script(round++);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await runAgent(task.userId, `Execute and verify mission ${task.missionId} step ${task.missionStepId}.`, [], "test/model", undefined, undefined, undefined, undefined, undefined, {
      taskId: task.id, missionId: task.missionId, missionStepId: task.missionStepId,
      toolAllow: missionWorkerToolAllowlist([]), enqueueMissionTask: queue.enqueue,
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.upstashVectorRestUrl = originalVectorUrl;
    config.upstashVectorRestToken = originalVectorToken;
  }
}

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
