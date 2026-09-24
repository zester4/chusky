import test, { before } from "node:test";
import assert from "node:assert/strict";
import { nativeTool } from "../src/nativeTools.js";
import { claimTask, claimTaskEnqueue, createTask, getTask, initStore, renewTaskLease, updateTask } from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("expired enqueue claims can be recovered after a publisher crash", async () => {
  const userId = 830000;
  const task = await createTask(userId, { id: "task_enqueue_recovery", title: "Publish", objective: "Publish exactly once" });
  assert.ok(await claimTaskEnqueue(userId, task.id, "crashed-publisher", 1_000));
  assert.equal(await claimTaskEnqueue(userId, task.id, "concurrent-publisher", 1_000), undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.ok(await claimTaskEnqueue(userId, task.id, "recovery-publisher", 1_000));
});

test("durable tasks checkpoint, complete, and remain private to their owner", async () => {
  const userId = 830001;
  const task = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "Build a dashboard", objective: "Create and verify the first dashboard version" }) as { id: string; status: string };
  assert.equal(task.status, "queued");

  const checkpointed = await nativeTool(userId, "CHUCK_TASK_CHECKPOINT", { id: task.id, checkpoint: "Scaffold is ready", nextAction: "Implement charts" }) as { status: string; checkpoint: string; nextAction: string };
  assert.equal(checkpointed.status, "running");
  assert.equal(checkpointed.checkpoint, "Scaffold is ready");
  assert.equal(checkpointed.nextAction, "Implement charts");

  await assert.rejects(() => nativeTool(830002, "CHUCK_TASK_GET", { id: task.id }), /not found or not owned/);
  const completed = await nativeTool(userId, "CHUCK_TASK_COMPLETE", { id: task.id, result: "Dashboard deployed" }) as { status: string; result: string };
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "Dashboard deployed");
  assert.equal((await getTask(userId, task.id))?.checkpoint, "Scaffold is ready");
});

test("task lifecycle rejects invalid transitions and retries recoverable tasks", async () => {
  const userId = 830003;
  const task = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "Investigate incident", objective: "Find root cause" }) as { id: string };
  await nativeTool(userId, "CHUCK_TASK_CANCEL", { id: task.id });
  const retried = await nativeTool(userId, "CHUCK_TASK_RETRY", { id: task.id }) as { status: string; attempt: number };
  assert.equal(retried.status, "queued");
  assert.equal(retried.attempt, 0);
  await nativeTool(userId, "CHUCK_TASK_COMPLETE", { id: task.id, result: "Resolved" });
  await assert.rejects(() => nativeTool(userId, "CHUCK_TASK_CANCEL", { id: task.id }), /unfinished tasks/);
  await assert.rejects(() => nativeTool(userId, "CHUCK_TASK_RETRY", { id: task.id }), /failed, blocked, or cancelled/);
});

test("a task can record a concrete blocker and recover without losing its checkpoint", async () => {
  const userId = 830005;
  const task = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "Connect source", objective: "Read the source repository" }) as { id: string };
  await nativeTool(userId, "CHUCK_TASK_CHECKPOINT", { id: task.id, checkpoint: "Repository URL identified" });
  const blocked = await nativeTool(userId, "CHUCK_TASK_BLOCK", { id: task.id, reason: "GitHub connection is missing", nextAction: "Ask the user to connect GitHub" }) as { status: string; error: string; checkpoint: string };
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error, "GitHub connection is missing");
  assert.equal(blocked.checkpoint, "Repository URL identified");
  assert.equal((await nativeTool(userId, "CHUCK_TASK_RETRY", { id: task.id }) as { status: string }).status, "queued");
});

test("task schemas expose the full durable lifecycle and reject malformed filters", async () => {
  const { chuckTools } = await import("../src/agentTools.js");
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_TASK_CREATE", "CHUCK_TASK_LIST", "CHUCK_TASK_GET", "CHUCK_TASK_CHECKPOINT", "CHUCK_TASK_BLOCK", "CHUCK_TASK_COMPLETE", "CHUCK_TASK_CANCEL", "CHUCK_TASK_RETRY"]) assert.equal(names.has(name), true);
  await assert.rejects(() => nativeTool(830004, "CHUCK_TASK_LIST", { statuses: ["not-a-status"] }), /statuses\[0\].*unsupported value/);
});

test("concurrent task mutations preserve both updates through versioned CAS retries", async () => {
  const userId = 830006;
  const task = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "Concurrent task", objective: "Preserve state" }) as { id: string };
  await Promise.all([
    updateTask(userId, task.id, { checkpoint: "checkpoint saved" }),
    updateTask(userId, task.id, { nextAction: "continue from checkpoint" }),
  ]);
  const latest = await getTask(userId, task.id);
  assert.equal(latest?.checkpoint, "checkpoint saved");
  assert.equal(latest?.nextAction, "continue from checkpoint");
  assert.equal(latest?.version, 2);
});

test("a running task lease can be renewed by its owning worker", async () => {
  const userId = 830007;
  const task = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "Long task", objective: "Remain claimable by one worker" }) as { id: string };
  const claimed = await claimTask(userId, task.id, "worker-a", 10_000);
  assert.ok(claimed?.lease);
  const before = claimed!.lease!.expiresAt;
  const renewed = await renewTaskLease(userId, task.id, claimed!.lease!.token, 60_000);
  assert.ok(renewed);
  assert.ok((renewed?.lease?.expiresAt ?? 0) > before);
  assert.equal(renewed?.lease?.workerId, "worker-a");
});
