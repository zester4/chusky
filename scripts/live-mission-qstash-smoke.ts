import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serve as serveWorkflow } from "@upstash/workflow/hono";
import { WorkflowNonRetryableError } from "@upstash/workflow";
import type { TaskWaitRequest } from "../src/types.js";
import type { TaskSliceContext } from "../src/taskSlice.js";
import { TASK_WAIT_MIN_SECONDS } from "../src/taskWait.js";

/**
 * Real QStash/Redis/Neon mission smoke test.
 *
 * The callback server is intentionally separate from src/index.ts so this
 * script never initializes Telegram polling or exposes the rest of Chusky.
 * The only injected fake is the model boundary.
 *
 * Required:
 *   WEBHOOK_URL=https://<temporary-public-tunnel>
 *
 * Optional:
 *   LIVE_MISSION_PORT=8091
 *   LIVE_MISSION_DELAYS_SECONDS=60,60,60
 *   LIVE_MISSION_TIMEOUT_MS=300000
 *   LIVE_MISSION_STORE_READ_TIMEOUT_MS=20000
 */

// Load the selected local/staging environment while preserving explicit shell
// overrides. This lets the runner use a staging env file and a temporary
// callback tunnel without accidentally replacing those values from .env.
const suppliedWebhookUrl = process.env.WEBHOOK_URL;
const suppliedPort = process.env.LIVE_MISSION_PORT;
const suppliedDelays = process.env.LIVE_MISSION_DELAYS_SECONDS;
const suppliedTimeout = process.env.LIVE_MISSION_TIMEOUT_MS;
loadDotenv({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });
if (suppliedWebhookUrl) process.env.WEBHOOK_URL = suppliedWebhookUrl;
if (suppliedPort) process.env.LIVE_MISSION_PORT = suppliedPort;
if (suppliedDelays) process.env.LIVE_MISSION_DELAYS_SECONDS = suppliedDelays;
if (suppliedTimeout) process.env.LIVE_MISSION_TIMEOUT_MS = suppliedTimeout;

const publicUrl = (process.env.WEBHOOK_URL ?? "").replace(/\/+$/, "");
if (!publicUrl) throw new Error("Set WEBHOOK_URL to the temporary public tunnel URL.");
const publicTarget = new URL(publicUrl);
if (publicTarget.protocol !== "https:") throw new Error("WEBHOOK_URL must use HTTPS.");
if (publicTarget.hostname.endsWith(".up.railway.app")) {
  throw new Error("This smoke test requires a local tunnel, not a Railway destination.");
}
for (const key of ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "REDIS_URL"]) {
  if (!process.env[key]) throw new Error("Missing " + key + ".");
}

const port = Number(process.env.LIVE_MISSION_PORT ?? "8091");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("LIVE_MISSION_PORT is invalid.");
const delays = (process.env.LIVE_MISSION_DELAYS_SECONDS ?? "60,60,60")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 1 && value <= 3600);
if (delays.length !== 3) throw new Error("LIVE_MISSION_DELAYS_SECONDS must contain exactly three values from 1 to 3600.");
if (delays.some((delay) => delay < TASK_WAIT_MIN_SECONDS)) {
  throw new Error(`LIVE_MISSION_DELAYS_SECONDS values must be at least ${TASK_WAIT_MIN_SECONDS} seconds because CHUCK_TASK_WAIT enforces the production minimum.`);
}
const defaultTimeoutMs = Math.max(180_000, delays.reduce((total, delay) => total + delay, 0) * 1000 + 120_000);
const timeoutMs = Number(process.env.LIVE_MISSION_TIMEOUT_MS ?? String(defaultTimeoutMs));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 3_600_000) {
  throw new Error("LIVE_MISSION_TIMEOUT_MS must be a whole number from 30000 to 3600000.");
}
const minimumTimeoutMs = delays.reduce((total, delay) => total + delay, 0) * 1000 + 120_000;
if (timeoutMs < minimumTimeoutMs) {
  throw new Error(`LIVE_MISSION_TIMEOUT_MS must be at least ${minimumTimeoutMs}ms for ${delays.join(",")} second waits plus QStash/network headroom.`);
}
const storeReadTimeoutMs = Number(process.env.LIVE_MISSION_STORE_READ_TIMEOUT_MS ?? "20000");
if (!Number.isSafeInteger(storeReadTimeoutMs) || storeReadTimeoutMs < 1_000 || storeReadTimeoutMs > 120_000) {
  throw new Error("LIVE_MISSION_STORE_READ_TIMEOUT_MS must be a whole number from 1000 to 120000.");
}

function withTimeout<T>(operation: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms. Check Redis connectivity and the staging network.`)), timeout);
    operation.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
console.error("[live-smoke] loading durable store and workflow modules");
const [
  { initStore, createMission, startMission, getMission, listTasks, acquireUserLock, releaseUserLock },
  { reconcileMissionExecution },
  { executeDurableTask },
  { executeTaskSlice },
  { nativeTool },
  { enqueueTaskWorkflow, workflowServeOptions },
  { parseTaskWorkflowPayload },
] = await Promise.all([
  import("../src/store.js"),
  import("../src/missionScheduler.js"),
  import("../src/taskRunner.js"),
  import("../src/taskSlice.js"),
  import("../src/nativeTools.js"),
  import("../src/triggerWorkflow.js"),
  import("../src/workflows.js"),
]);
console.error("[live-smoke] modules loaded");

type ScriptedOptions = {
  taskId?: string;
  missionId?: string;
  missionStepId?: string;
  missionTimerResumed?: boolean;
};

let missionId = "";
let modelCalls = 0;
const stages = delays.map((delaySeconds, index) => ({
  id: "live-stage-" + (index + 1),
  title: "Live QStash stage " + (index + 1),
  delaySeconds,
}));

const scriptedAgent: NonNullable<TaskSliceContext["runAgent"]> = async (...args) => {
  const options = args[9] as ScriptedOptions | undefined;
  if (!options?.taskId || options.missionId !== missionId || !options.missionStepId) {
    throw new Error("The scripted model received an unexpected mission context.");
  }
  const stage = stages.find((candidate) => candidate.id === options.missionStepId);
  if (!stage) throw new Error("Unknown mission step: " + options.missionStepId);
  modelCalls += 1;
  const runtime = {
    taskId: options.taskId,
    missionId,
    missionStepId: stage.id,
    enqueueMissionTask: enqueueTaskWorkflow,
  };
  const userId = Number(process.env.LIVE_MISSION_USER_ID);

  if (!options.missionTimerResumed) {
    let request: TaskWaitRequest | undefined;
    await nativeTool(
      userId,
      "CHUCK_TASK_WAIT",
      {
        delaySeconds: stage.delaySeconds,
        checkpoint: stage.title + " checkpoint saved before sleep",
        nextAction: "Verify " + stage.title + " after the QStash wake",
      },
      { ...runtime, requestTaskWait: (value: TaskWaitRequest) => { request = value; } },
    );
    if (!request) throw new Error("CHUCK_TASK_WAIT did not return a wait request.");
    return {
      text: stage.title + " is sleeping on a real QStash timer.",
      toolsUsed: ["CHUCK_TASK_WAIT"],
      toolsSucceeded: ["CHUCK_TASK_WAIT"],
      taskWait: request,
    };
  }

  await nativeTool(
    userId,
    "CHUCK_MISSION_CHECKPOINT",
    {
      id: missionId,
      checkpoint: stage.title + " checkpoint verified after wake",
      nextAction: "Complete " + stage.title,
    },
    runtime,
  );
  await nativeTool(
    userId,
    "CHUCK_MISSION_STEP_COMPLETE",
    {
      id: missionId,
      stepId: stage.id,
      result: stage.title + " completed after a real QStash wake",
    },
    runtime,
  );
  return {
    text: stage.title + " completed after the real QStash wake.",
    toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
    toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
  };
};

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, service: "live-mission-qstash-smoke" }));
app.post(
  "/workflows/task",
  serveWorkflow(async (workflow) => {
    let payload: { taskId: string; userId: number };
    try {
      payload = parseTaskWorkflowPayload(workflow.requestPayload);
    } catch (error) {
      throw new WorkflowNonRetryableError(error instanceof Error ? error.message : "Invalid task workflow payload");
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const run = await workflow.run("execute-task-" + attempt, async () => executeDurableTask(payload, {
        workerId: "live-qstash-smoke:" + (workflow.workflowRunId ?? "task") + ":" + attempt,
        execute: (task, leaseSignal) => executeTaskSlice(task, leaseSignal, {
          workflowRunId: workflow.workflowRunId,
          attempt,
          sdkTaskMessage: async (current) => current?.objective ?? "",
          sdkTaskSkillInstructions: async () => undefined,
          sdkDurationSeconds: () => undefined,
          sendMessage: async () => undefined,
          withUserLock: async <T>(userId: number, _signal: AbortSignal | undefined, work: () => Promise<T>) => {
            const token = "live-qstash-smoke:" + userId;
            if (!(await acquireUserLock(userId, token))) throw new Error("Could not acquire the local smoke-test owner lock.");
            try { return await work(); } finally { await releaseUserLock(userId, token); }
          },
          runAgent: scriptedAgent,
          enqueueMissionTask: enqueueTaskWorkflow,
        }),
      }));

      if (!run.claimed && run.task?.status === "queued") {
        const now = Date.now();
        const wakeAt = Math.max(run.task.runAt ?? now, now + 1000);
        if (attempt >= 9) {
          if (run.task.id) await enqueueTaskWorkflow(payload.userId, run.task.id, wakeAt);
          break;
        }
        await workflow.sleep("retry-claim-" + attempt, Math.max(1, Math.ceil((wakeAt - now) / 1000)));
        continue;
      }
      if (run.task?.status !== "queued" || !run.task.runAt) break;
      if (attempt >= 9) {
        await enqueueTaskWorkflow(payload.userId, run.task.id, run.task.runAt);
        break;
      }
      await workflow.sleep("retry-delay-" + attempt, Math.max(1, Math.ceil((run.task.runAt - Date.now()) / 1000)));
      // The named sleep is complete when QStash replays this workflow. Move
      // to a new execution step instead of registering the same sleep again.
      continue;
    }
  }, workflowServeOptions(publicUrl + "/workflows/task")),
);

await initStore();
console.error("[live-smoke] staging Redis/Neon store initialized");
const userId = Number(process.env.LIVE_MISSION_USER_ID ?? String(7_906_000_000 + (Date.now() % 900_000)));
if (!Number.isSafeInteger(userId) || userId < 1) throw new Error("LIVE_MISSION_USER_ID is invalid.");
process.env.LIVE_MISSION_USER_ID = String(userId);

const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
  const instance = serve({ fetch: app.fetch, port }, () => resolve(instance));
  instance.once("error", reject);
});
console.error("[live-smoke] callback server listening on port " + port);

try {
  const health = await fetch("http://127.0.0.1:" + port + "/health");
  if (!health.ok) throw new Error("Local callback server health check failed with " + health.status + ".");

  const mission = await createMission(userId, {
    title: "Real QStash mission smoke test",
    objective: "Exercise three durable sleep/wake continuations through real QStash delivery.",
    definitionOfDone: "All three stages complete after real QStash wakes without a model-provider call.",
    steps: stages.map((stage, index) => ({
      id: stage.id,
      title: stage.title,
      objective: "Wait " + stage.delaySeconds + " seconds, wake through QStash, verify the checkpoint, and complete this stage.",
      ...(index ? { dependsOn: [stages[index - 1].id] } : {}),
    })),
  });
  missionId = mission.id;
  await startMission(userId, mission.id);
  const scheduled = await reconcileMissionExecution(userId, mission.id, enqueueTaskWorkflow);
  if (!scheduled) throw new Error("Mission could not be scheduled.");
  console.error("[live-smoke] mission " + mission.id + " scheduled through QStash");

  const deadline = Date.now() + timeoutMs;
  const readState = async () => {
    const [currentMission, allTasks] = await withTimeout(
      Promise.all([getMission(userId, mission.id), listTasks(userId)]),
      storeReadTimeoutMs,
      "Durable mission state read",
    );
    return {
      mission: currentMission,
      tasks: allTasks.filter((task) => task.missionId === mission.id),
    };
  };
  let state = await readState();
  let finalMission = state.mission;
  let tasks = state.tasks;
  let terminalMissionObservedWithUnsettledTask = false;
  let lastProgress = "";
  let lastProgressAt = 0;
  while (finalMission && Date.now() < deadline) {
    const elapsedSeconds = Math.floor((Date.now() - (deadline - timeoutMs)) / 1000);
    const taskSummary = tasks.map((task) => `${task.missionStepId ?? task.id}:${task.status}`).join(",") || "none";
    const progress = `t+${elapsedSeconds}s mission=${finalMission.status} tasks=${taskSummary}`;
    if (progress !== lastProgress || Date.now() - lastProgressAt >= 10_000) {
      console.error("[live-smoke] " + progress);
      lastProgress = progress;
      lastProgressAt = Date.now();
    }
    const missionTerminal = ["completed", "blocked", "failed", "cancelled"].includes(finalMission.status);
    const tasksTerminal = tasks.length > 0 && tasks.every((task) => ["completed", "blocked", "failed", "cancelled"].includes(task.status));
    if (missionTerminal && tasks.some((task) => !["completed", "cancelled"].includes(task.status))) terminalMissionObservedWithUnsettledTask = true;
    if (missionTerminal && tasksTerminal) break;
    await sleep(1000);
    state = await readState();
    finalMission = state.mission;
    tasks = state.tasks;
  }
  if (finalMission && Date.now() >= deadline && !["completed", "blocked", "failed", "cancelled"].includes(finalMission.status)) {
    console.error(`[live-smoke] timed out after ${timeoutMs}ms while mission remained ${finalMission.status}.`);
  }
  console.error("[live-smoke] mission terminal state: " + (finalMission?.status ?? "missing"));
  state = await readState();
  finalMission = state.mission;
  tasks = state.tasks;
  const allTasksCompleted = tasks.length === stages.length && tasks.every((task) => task.status === "completed");
  const result = {
    ok: finalMission?.status === "completed" && allTasksCompleted && !terminalMissionObservedWithUnsettledTask,
    missionId: mission.id,
    userId,
    status: finalMission?.status,
    modelCalls,
    taskStatuses: tasks.map((task) => ({ id: task.id, stepId: task.missionStepId, status: task.status, attempts: task.attempt })),
    allTasksCompleted,
    terminalMissionObservedWithUnsettledTask,
    delays,
    timeoutMs,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
