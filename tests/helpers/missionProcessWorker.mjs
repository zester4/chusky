import { createRequire } from "node:module";
import { resolve } from "node:path";
import { installProofRedisIsolation } from "./missionRedisIsolation.mjs";

const root = process.env.MISSION_PROOF_COMPILED_DIR;
if (!root) throw new Error("Compile the isolated mission proof runtime before launching workers.");
const require = createRequire(import.meta.url);
const runtime = (module) => require(resolve(root, `${module}.js`));
let probing = false;
let sequence = 0;
const permits = new Map();
process.on("message", (message) => {
  if (message?.kind !== "continue") return;
  const permit = permits.get(message.sequence);
  if (permit) { permits.delete(message.sequence); permit(); }
});
async function boundary(id, phase) {
  if (!probing) return;
  const current = ++sequence;
  await new Promise((permit) => {
    permits.set(current, permit);
    process.send({ kind: "boundary", id, phase, sequence: current });
  });
}
globalThis.__missionAwait = async (id, operation) => {
  await boundary(id, "before");
  try {
    const result = await operation();
    await boundary(id, "after");
    return result;
  } catch (error) {
    await boundary(id, "rejected");
    throw error;
  }
};

async function main() {
  const input = JSON.parse(process.argv[2]);
  if (!input.memoryOnly) installProofRedisIsolation(require, process.env.MISSION_PROCESS_REDIS_PREFIX, (key) => process.send({ kind: "redisKey", key }));
  const { logger } = runtime("logger");
  logger.level = "silent";
  const store = runtime("store");
  const { config } = runtime("config");
  config.upstashVectorRestUrl = "";
  config.upstashVectorRestToken = "";
  config.redisUrl = input.memoryOnly ? "" : process.env.MISSION_PROCESS_REDIS_URL;
  if (!input.memoryOnly && !config.redisUrl) throw new Error("An isolated MISSION_PROCESS_REDIS_URL is required; production REDIS_URL is never used.");
  await store.initStore({ memoryOnly: input.memoryOnly });
  if (!input.memoryOnly && !store.isDurableStore()) throw new Error("Crash proof requires the real durable Redis store.");
  const { reconcileMissionExecution } = runtime("missionScheduler");
  const { executeDurableTask } = runtime("taskRunner");
  const { executeTaskSlice } = runtime("taskSlice");
  const { nativeTool } = runtime("nativeTools");
  Date.now = () => input.now;
  const enqueue = async (_owner, taskId) => `proof-workflow-${taskId}`;
  let fixture = input.fixture;
  if (!fixture) {
    const mission = await store.createMission(input.userId, {
      title: "Process crash fixture", objective: "Persist one verified internal unit", definitionOfDone: "Unit verified",
      ...(input.scenario === "strict" ? { verificationMode: "strict", requiredEvidence: ["kind:tool_receipt"] } : {}),
      steps: [{ id: "unit", title: "Unit", objective: "Complete one bounded internal unit", ...(input.scenario === "strict" ? { evidenceRequired: ["kind:tool_receipt"] } : {}) }],
    });
    await store.startMission(input.userId, mission.id);
    await reconcileMissionExecution(input.userId, mission.id, enqueue);
    fixture = { userId: input.userId, missionId: mission.id, taskId: (await store.getMission(input.userId, mission.id)).rootTaskId, scenario: input.scenario ?? "complete" };
  }
  if (input.mode === "prepare") return { fixture };
  if (input.mode === "race") {
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimTask(fixture.userId, fixture.taskId, `racing-worker-${index}`, 10000)));
    const winners = claims.filter(Boolean);
    if (winners.length !== 1) throw new Error(`Concurrent claim returned ${winners.length} owners instead of one.`);
    const current = await store.getTask(fixture.userId, fixture.taskId);
    if (current?.lease?.token !== winners[0].lease.token) throw new Error("The successful claimant does not own the persisted lease.");
    return { fixture, taskStatus: current.status };
  }
  if (input.mode === "recover") {
    const current = await store.getMission(fixture.userId, fixture.missionId);
    if (current?.waiting?.kind === "provider_event") await store.resumeMissionFromProviderEvent(fixture.userId, fixture.missionId, "fixture", "exact-fixture-event");
    if (current?.waiting?.kind === "approval") {
      await store.claimApproval(fixture.userId, current.waiting.key);
      await runtime("missionApproval").resumeMissionTaskAfterApproval(fixture.userId, current.waiting.key, enqueue);
    }
    await reconcileMissionExecution(fixture.userId, fixture.missionId, enqueue);
  }
  probing = input.mode !== "recover";
  await executeDurableTask({ userId: fixture.userId, taskId: fixture.taskId }, {
    workerId: `process-proof-${process.pid}`, leaseMs: 10000,
    execute: (task, signal) => executeTaskSlice(task, signal, {
      attempt: 0, workflowRunId: "process-proof", enqueueMissionTask: enqueue,
      sdkTaskMessage: async (current) => current.objective, sdkTaskSkillInstructions: async () => undefined,
      sdkDurationSeconds: () => undefined, sendMessage: async () => undefined,
      // Account-lock expiry is real Redis wall time, independent of the fake
      // mission clock. One second keeps kill/restart tests bounded.
      withUserLock: async (owner, _signal, work) => {
        const token = `process-proof-owner-${process.pid}`;
        if (!await store.acquireUserLock(owner, token, 1)) throw new Error("Fixture account lease has not expired.");
        try { return await work(); } finally { await store.releaseUserLock(owner, token); }
      },
      runAgent: async () => {
        const nativeContext = { taskId: task.id, missionId: fixture.missionId, enqueueMissionTask: enqueue };
        if (input.mode !== "recover") {
          if (fixture.scenario === "timer") {
            let taskWait;
            await nativeTool(task.userId, "CHUCK_TASK_WAIT", { delaySeconds: 60, checkpoint: "Fixture work parked", nextAction: "Verify the unit after the timer" }, { ...nativeContext, requestTaskWait: (request) => { taskWait = request; } });
            return { text: "Timer parked", toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], taskWait };
          }
          if (fixture.scenario === "provider") {
            let missionWait;
            await nativeTool(task.userId, "CHUCK_MISSION_WAIT_EVENT", { id: fixture.missionId, provider: "fixture", providerEventId: "exact-fixture-event", stepId: "unit", timeoutSeconds: 60, checkpoint: "Await exact event", nextAction: "Verify after the event" }, { ...nativeContext, requestMissionWait: (request) => { missionWait = request; } });
            return { text: "Event parked", toolsUsed: ["CHUCK_MISSION_WAIT_EVENT"], toolsSucceeded: ["CHUCK_MISSION_WAIT_EVENT"], missionWait };
          }
          if (fixture.scenario === "approval") {
            const approval = await store.createApproval({ userId: task.userId, missionId: fixture.missionId, toolSlug: "FIXTURE_APPROVED_ACTION", args: { unit: "unit" }, request: "Approve one bounded fixture action", history: [], model: "test/model" });
            throw new (runtime("agent").ApprovalRequiredError)(approval.id, approval.toolSlug, approval.args);
          }
          if (fixture.scenario === "checkpoint") {
            await nativeTool(task.userId, "CHUCK_MISSION_CHECKPOINT", { id: fixture.missionId, checkpoint: "Verified intermediate frontier", nextAction: "Finish the unit" }, nativeContext);
            return { text: "Frontier saved", toolsUsed: ["CHUCK_MISSION_CHECKPOINT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT"] };
          }
          if (fixture.scenario === "failure") throw new Error("Synthetic transient inference failure");
          if (fixture.scenario === "prose") return { text: "I will do this later", toolsUsed: [], toolsSucceeded: [] };
          if (fixture.scenario === "cancel") {
            await nativeTool(task.userId, "CHUCK_MISSION_CANCEL", { id: fixture.missionId, reason: "Owner cancelled the fixture" }, nativeContext);
            return { text: "Cancelled", toolsUsed: ["CHUCK_MISSION_CANCEL"], toolsSucceeded: ["CHUCK_MISSION_CANCEL"] };
          }
          if (fixture.scenario === "replan") {
            await nativeTool(task.userId, "CHUCK_MISSION_REPLAN", { id: fixture.missionId, reason: "Preserve identity while replacing unfinished work", steps: [{ id: "unit", title: "Replanned unit", objective: "Complete one bounded internal unit" }] }, nativeContext);
            return { text: "Replanned", toolsUsed: ["CHUCK_MISSION_REPLAN"], toolsSucceeded: ["CHUCK_MISSION_REPLAN"] };
          }
        }
        if (fixture.scenario === "strict") await store.recordTrustedMissionEvidence(task.userId, fixture.missionId, [{ id: "fixture-unit-receipt", kind: "tool_receipt", summary: "Server fixture verified the internal unit", ref: "fixture://verified-unit", verified: true }], "unit");
        await nativeTool(task.userId, "CHUCK_MISSION_STEP_COMPLETE", {
          id: fixture.missionId, stepId: "unit", result: "Internal unit verified",
        }, nativeContext);
        return { text: "Verified internal unit", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
      },
    }),
  });
  probing = false;
  return { fixture, missionStatus: (await store.getMission(fixture.userId, fixture.missionId))?.status, taskStatus: (await store.getTask(fixture.userId, fixture.taskId))?.status };
}

main().then((result) => {
  process.send({ kind: "done", result }, () => process.exit(0));
}).catch((error) => {
  // Never serialize Redis/client errors, URLs, command arguments or credentials.
  const frames = String(error?.stack ?? "").split("\n").slice(1, 4).map((frame) => frame.replace(/rediss?:\/\/\S+/g, "[redacted-connection]"));
  const missingModule = error?.code === "MODULE_NOT_FOUND" ? /Cannot find module '([^']+)'/.exec(error.message)?.[1] : undefined;
  process.send({ kind: "failed", errorClass: error?.name, code: error?.code, missingModule, frames }, () => process.exit(1));
});
