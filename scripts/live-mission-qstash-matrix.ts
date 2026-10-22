/**
 * Real QStash delivery into the production mission/task coordinator, with
 * scripted decisions and isolated in-memory storage. No model/provider tools.
 *
 * Run: node --use-env-proxy --import=tsx scripts/live-mission-qstash-matrix.ts --apply
 *
 * Smee acknowledges HTTP delivery before local processing. This proves signed
 * transport, delays, and coordinator behavior, NOT end-to-end receiver retries,
 * Upstash Workflow replay, process-restart durability, or Redis/Neon persistence.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client, Receiver } from "@upstash/qstash";
import type { TaskSliceContext } from "../src/taskSlice.js";
import type { TaskWaitRequest } from "../src/types.js";

async function main(): Promise<void> {
if (!process.argv.includes("--apply")) throw new Error("Pass --apply to publish synthetic real QStash messages.");
for (const name of ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}
process.env.DOTENV_CONFIG_PATH = resolve(__dirname, "../tests/empty.env");
process.env.JEV_MODE = "off";
process.env.TURN_OPENING_ENABLED = "false";
process.env.LOG_LEVEL = "error";
// The injected worker is the only agent entry point. A network allowlist also
// makes an accidental inference, tool, or notification dispatch fail before I/O.
const nativeFetch = globalThis.fetch.bind(globalThis);
const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";
const allowedHosts = new Set([new URL(qstashUrl).hostname, "smee.io"]);
let deniedNetworkCalls = 0;
const deniedHosts = new Set<string>();
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowedHosts.has(url.hostname)) {
    deniedNetworkCalls++;
    deniedHosts.add(url.hostname);
    throw new Error("Live mission proof blocked a non-queue network request.");
  }
  return nativeFetch(input, init);
};

const store = await import("../src/store.js");
const { reconcileMissionExecution } = await import("../src/missionScheduler.js");
const { executeDurableTask } = await import("../src/taskRunner.js");
const { executeTaskSlice } = await import("../src/taskSlice.js");
const { nativeTool } = await import("../src/nativeTools.js");
const { schedulePhoneCallFollowUps } = await import("../src/calls/followUp.js");
const { enqueueTaskWithClaim } = await import("../src/taskEnqueue.js");
await store.initStore({ memoryOnly: true });

const client = new Client({ token: process.env.QSTASH_TOKEN!, baseUrl: qstashUrl });
const receiver = new Receiver({ currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!, nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY! });
const relay = await fetch("https://smee.io/new", { redirect: "manual", signal: AbortSignal.timeout(15000) });
const relayLocation = relay.headers.get("location");
if (!relayLocation || new URL(relayLocation).hostname !== "smee.io") throw new Error("Could not allocate a temporary webhook relay.");
const destination: string = relayLocation;
const suiteId = randomUUID();
const owners = new Set<number>();
const messageIds: string[] = [];
const errors: string[] = [];
const executions = new Map<string, number>();
const signedDeliveries = new Set<string>();
const scenarioMissions = new Map<string, { userId: number; missionId: string }>();
const callTasks = new Map<string, { userId: number; callId: string }>();
const processing = new Set<Promise<void>>();
let scriptedAgentRuns = 0;
let cancelledExecutions = 0;
let ignoredForeignDeliveries = 0;
let timerDeadline = 0;
let timerLatenessMs = 0;
let streamReady!: () => void;
const ready = new Promise<void>((resolve) => { streamReady = resolve; });
const streamAbort = new AbortController();

const enqueue = async (userId: number, taskId: string, runAt = Date.now()) => {
  assert.ok(owners.has(userId), "Only synthetic owners may publish");
  assert.ok(messageIds.length < 40, "Synthetic queue publication limit exceeded");
  const accepted = await client.publishJSON({
    url: destination,
    body: { suiteId, userId, taskId },
    delay: Math.max(1, Math.ceil((runAt - Date.now()) / 1000)),
    retries: 0,
  });
  messageIds.push(accepted.messageId);
  return accepted.messageId;
};

const scriptedAgent: NonNullable<TaskSliceContext["runAgent"]> = async (...args) => {
  const userId = args[0];
  const options = args[9];
  assert.ok(owners.has(userId) && options?.taskId);
  const callTask = callTasks.get(options.taskId);
  if (callTask) {
    assert.equal(callTask.userId, userId);
    assert.equal((await store.getPhoneCall(userId, callTask.callId))?.status, "ended");
    scriptedAgentRuns++;
    executions.set(options.taskId, (executions.get(options.taskId) ?? 0) + 1);
    await nativeTool(userId, "CHUCK_TASK_COMPLETE", { id: options.taskId, result: "Persisted synthetic call is ended; no call was dialed" }, { taskId: options.taskId });
    return { text: "Persisted synthetic call is ended; no call was dialed", toolsUsed: ["CHUCK_TASK_COMPLETE"], toolsSucceeded: ["CHUCK_TASK_COMPLETE"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "CHUCK_TASK_COMPLETE", status: "succeeded", dispatched: true }] };
  }
  assert.ok(options.missionId && options.missionStepId);
  const mission = await store.getMission(userId, options.missionId);
  assert.ok(mission);
  const step = mission.steps.find((candidate) => candidate.id === options.missionStepId);
  assert.ok(step);
  for (const dependency of step.dependsOn) assert.equal(mission.steps.find((candidate) => candidate.id === dependency)?.status, "completed");
  scriptedAgentRuns++;
  executions.set(options.taskId, (executions.get(options.taskId) ?? 0) + 1);
  if (mission.title === "cancelled") cancelledExecutions++;
  const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: step.id, enqueueMissionTask: enqueue };
  if (mission.title === "timer" && !options.missionTimerResumed) {
    let wait: TaskWaitRequest | undefined;
    await nativeTool(userId, "CHUCK_TASK_WAIT", { delaySeconds: 60, checkpoint: "Synthetic timer checkpoint", nextAction: "Complete this same step after its real queue wake" }, { ...runtime, requestTaskWait: (value) => { wait = value; } });
    assert.ok(wait);
    timerDeadline = wait.runAt;
    return { text: "Parked until real queue wake", toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "CHUCK_TASK_WAIT", status: "succeeded", dispatched: true }], taskWait: wait };
  }
  if (mission.title === "timer") {
    assert.ok(timerDeadline && Date.now() >= timerDeadline, "A delayed step executed before its saved deadline");
    timerLatenessMs = Date.now() - timerDeadline;
  }
  await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: step.id, result: "Synthetic internal stage verified" }, runtime);
  return { text: "Stage verified", toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded", dispatched: true }] };
};

async function receive(data: string) {
  const envelope = JSON.parse(data);
  const payload = envelope.body;
  if (payload?.suiteId !== suiteId) return;
  const signature = envelope["upstash-signature"];
  assert.equal(typeof signature, "string");
  assert.ok(await receiver.verify({ signature, body: JSON.stringify(payload), url: destination }));
  signedDeliveries.add(envelope["upstash-message-id"] || signature);
  assert.ok(owners.has(payload.userId), "Unexpected test owner");
  const result = await executeDurableTask({ userId: payload.userId, taskId: payload.taskId }, {
    workerId: `live-proof-${randomUUID()}`,
    execute: (task, signal) => executeTaskSlice(task, signal, {
      attempt: task.attempt ?? 0,
      workflowRunId: `live-proof-${suiteId}`,
      runAgent: scriptedAgent,
      enqueueMissionTask: enqueue,
      sdkTaskMessage: async (current) => current?.objective ?? "",
      sdkTaskSkillInstructions: async () => undefined,
      sdkDurationSeconds: () => undefined,
      sendMessage: async () => undefined,
      withUserLock: async (owner, _signal, work) => {
        const token = randomUUID();
        assert.ok(await store.acquireUserLock(owner, token));
        try { return await work(); } finally { await store.releaseUserLock(owner, token); }
      },
    }),
  });
  if (!result.task) ignoredForeignDeliveries++;
  if (result.task?.status === "queued") await enqueue(payload.userId, payload.taskId, result.task.runAt);
}

const stream = (async () => {
  const response = await fetch(destination, { headers: { accept: "text/event-stream" }, signal: streamAbort.signal });
  if (!response.ok || !response.body) throw new Error("Relay subscription failed");
  streamReady();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || frame.includes("event: ready")) continue;
      const work = receive(data).catch((error) => { errors.push(error instanceof Error ? error.message : "Receiver failed"); });
      processing.add(work);
      void work.finally(() => processing.delete(work));
    }
  }
})().catch((error) => { if (!streamAbort.signal.aborted) errors.push(error instanceof Error ? error.message : "Relay stream failed"); });

try {
  await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Relay did not become ready")), 15000).unref())]);
  const baseOwner = 7_907_000_000 + Math.floor(Math.random() * 900000);
  for (const [index, name] of ["chain", "diamond", "duplicate", "timer", "cancelled"].entries()) {
    const userId = baseOwner + index;
    owners.add(userId);
    const steps = name === "diamond"
      ? [{ id: "root", dependsOn: [] }, { id: "left", dependsOn: ["root"] }, { id: "right", dependsOn: ["root"] }, { id: "join", dependsOn: ["left", "right"] }]
      : (name === "chain" ? ["one", "two", "three"] : ["unit"]).map((id, i, all) => ({ id, dependsOn: i ? [all[i - 1]] : [] }));
    const mission = await store.createMission(userId, { title: name, objective: "Verify synthetic queue-driven mission coordination", definitionOfDone: "Every dependency is honored and each step is settled once", steps: steps.map((step) => ({ ...step, title: step.id, objective: "Complete one synthetic internal stage" })) });
    scenarioMissions.set(name, { userId, missionId: mission.id });
    await store.startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, enqueue);
    const task = (await store.listTasks(userId)).find((candidate) => candidate.missionId === mission.id)!;
    if (name === "duplicate") {
      await enqueue(userId, task.id);
      const foreignOwner = baseOwner + 100;
      owners.add(foreignOwner);
      await enqueue(foreignOwner, task.id);
    }
    if (name === "cancelled") await store.cancelMission(userId, mission.id);
    console.error(`[live-matrix] scheduled ${name}`);
  }
  const callOwner = baseOwner + 10;
  owners.add(callOwner);
  const call = { id: `twc_${randomUUID()}`, userId: callOwner, provider: "twilio" as const, direction: "outbound" as const, phoneNumber: "+15005550006", purpose: "Synthetic queue proof; never dial", status: "ended" as const, createdAt: Date.now(), updatedAt: Date.now() };
  const outcome = { title: "Synthetic internal follow-up", summary: "Verify this test record only", decisions: [], actionItems: [{ task: "Review the persisted synthetic call record and report its verified terminal status", owner: "Chusky" }], openQuestions: [] };
  await store.addPhoneCall(callOwner, { ...call, outcome });
  const enqueueCallTask = async (userId: number, taskId: string, runAt: number) => {
    callTasks.set(taskId, { userId, callId: call.id });
    return enqueueTaskWithClaim(userId, taskId, runAt, enqueue);
  };
  const first = await schedulePhoneCallFollowUps(call, outcome, { enqueueTask: enqueueCallTask });
  const repeated = await schedulePhoneCallFollowUps(call, outcome, { enqueueTask: enqueueCallTask });
  assert.deepEqual(first.taskIds, repeated.taskIds);
  assert.equal(first.scheduled, 1);
  assert.equal(repeated.scheduled, 0);
  console.error("[live-matrix] scheduled idempotent call-outcome follow-up");
  const deadline = Date.now() + 150000;
  let completed = false;
  while (Date.now() < deadline && !errors.length) {
    const missions = await Promise.all([...scenarioMissions.values()].map(({ userId, missionId }) => store.getMission(userId, missionId)));
    completed = missions.every((mission) => mission && ["completed", "cancelled"].includes(mission.status));
    const callsCompleted = (await Promise.all([...callTasks].map(([id, { userId }]) => store.getTask(userId, id)))).every((task) => task?.status === "completed");
    if (completed && callsCompleted && signedDeliveries.size >= 14) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await Promise.all([...processing]);
  const scenarios = await Promise.all([...scenarioMissions].map(async ([name, { userId, missionId }]) => {
    const mission = await store.getMission(userId, missionId);
    const tasks = (await store.listTasks(userId)).filter((task) => task.missionId === missionId);
    return { name, status: mission?.status, steps: mission?.steps.map(({ id, status }) => ({ id, status })), scriptedExecutions: tasks.map((task) => executions.get(task.id) ?? 0) };
  }));
  assert.ok(completed, "Missions did not reach their expected terminal state");
  assert.deepEqual(errors, []);
  if (deniedNetworkCalls) console.error(JSON.stringify({ deniedNetworkCalls, deniedHosts: [...deniedHosts] }));
  assert.ok([...deniedHosts].every((host) => ["registry.npmjs.org", "telemetry.composio.dev"].includes(host)), "Unexpected non-queue network activity was blocked");
  assert.equal(cancelledExecutions, 0);
  assert.equal(ignoredForeignDeliveries, 1);
  for (const scenario of scenarios) if (!["timer", "cancelled"].includes(scenario.name)) assert.ok(scenario.scriptedExecutions.every((count) => count === 1));
  assert.deepEqual(scenarios.find((scenario) => scenario.name === "timer")?.scriptedExecutions, [2]);
  for (const [id, { userId }] of callTasks) {
    assert.equal((await store.getTask(userId, id))?.status, "completed");
    assert.equal(executions.get(id), 1);
  }
  console.log(JSON.stringify({ ok: true, storage: "isolated-memory", queue: "real-qstash", modelProviderCalls: 0, scriptedAgentRuns, signedDeliveries: signedDeliveries.size, publications: messageIds.length, ignoredForeignDeliveries, timerLatenessMs, callFollowUp: "completed-once", blockedBackgroundHosts: [...deniedHosts], scenarios, limitations: ["relay acknowledges before local processing", "receiver retries, Workflow replay, Redis/Neon and process restarts not proven", "synthetic call record only; Twilio, audio and real business actions not tested"] }, null, 2));
} finally {
  streamAbort.abort();
  await stream;
  await Promise.allSettled(messageIds.map((id) => client.messages.delete(id)));
  await store.closeStore();
  globalThis.fetch = nativeFetch;
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Live queue matrix failed");
  process.exitCode = 1;
});
