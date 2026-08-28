import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createTask, getTask, initStore, settleTaskRun } from "../src/store.js";
import { executeDurableTask } from "../src/taskRunner.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("only one worker can claim a queued task and the stale worker cannot settle it", async () => {
  const userId = 840001;
  const task = await createTask(userId, { title: "Run once", objective: "Verify leasing" });
  let executions = 0;
  const worker = (workerId: string) => executeDurableTask({ userId, taskId: task.id }, {
    workerId,
    execute: async () => { executions++; return { status: "completed" as const, message: "done", result: "verified" }; },
  });
  const [first, second] = await Promise.all([worker("worker-a"), worker("worker-b")]);
  assert.equal(executions, 1);
  assert.equal([first.claimed, second.claimed].filter(Boolean).length, 1);
  assert.equal((await getTask(userId, task.id))?.status, "completed");
  assert.equal(await settleTaskRun(userId, task.id, "stale-token", { status: "failed", message: "should not write" }), undefined);
});

test("transient worker failures are retried with a bounded delayed requeue", async () => {
  const userId = 840002;
  const task = await createTask(userId, { title: "Retry", objective: "Exercise backoff", maxAttempts: 2 });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "worker", execute: async () => { throw new Error("temporary provider outage"); } });
  assert.equal(run.claimed, true);
  assert.equal(run.task?.status, "queued");
  assert.equal(run.task?.attempt, 1);
  assert.ok((run.task?.runAt ?? 0) > Date.now());
  assert.equal(run.task?.events.at(-1)?.type, "failed");
});

test("a task stops retrying once its bounded attempt budget is exhausted", async () => {
  const userId = 840004;
  const task = await createTask(userId, { title: "Bounded retry", objective: "Do not loop forever", maxAttempts: 1 });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "worker", execute: async () => { throw new Error("permanent failure"); } });
  assert.equal(run.task?.status, "failed");
  assert.equal(run.task?.attempt, 1);
  assert.equal(run.task?.runAt, undefined);
});

test("blocked executions retain their checkpoint and emit an audit event", async () => {
  const userId = 840003;
  const task = await createTask(userId, { title: "Needs approval", objective: "Stop safely" });
  const run = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "worker",
    execute: async () => ({ status: "blocked", message: "Approval required", checkpoint: "Read-only inspection completed", nextAction: "Approve the proposed action" }),
  });
  assert.equal(run.task?.status, "blocked");
  assert.equal(run.task?.checkpoint, "Read-only inspection completed");
  assert.equal(run.task?.nextAction, "Approve the proposed action");
  assert.equal(run.task?.events.at(-1)?.type, "blocked");
});
