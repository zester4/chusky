import test from "node:test";
import assert from "node:assert/strict";
import { createTask, getTask, initStore, setTaskWorkflowRunId, updateTask } from "../src/store.js";
import { recoverQueuedTaskWorkflows } from "../src/taskRecovery.js";

test("generic recovery republishes a queued task left before workflow publication", async () => {
  await initStore({ memoryOnly: true });
  const userId = 974001;
  const task = await createTask(userId, { title: "Recover approval", objective: "Continue the approved action.", runAt: Date.now() });
  const published: string[] = [];

  const first = await recoverQueuedTaskWorkflows(async (_ownerId, taskId) => {
    published.push(taskId);
    return "workflow-recovered-approval";
  }, { maxOwners: 10, maxTasksPerOwner: 20 });

  assert.equal(first.republished, 1);
  assert.deepEqual(published, [task.id]);
  assert.equal((await getTask(userId, task.id))?.workflowRunId, "workflow-recovered-approval");

  const second = await recoverQueuedTaskWorkflows(async () => {
    throw new Error("a recorded workflow must not be duplicated");
  }, { maxOwners: 10, maxTasksPerOwner: 20 });
  assert.equal(second.republished, 0);
  assert.equal(second.skipped, 1);
});

test("generic recovery replaces an expired pending publication claim", async () => {
  await initStore({ memoryOnly: true });
  const userId = 974002;
  const task = await createTask(userId, { title: "Recover pending approval", objective: "Resume after publisher crash.", runAt: Date.now() });
  await updateTask(userId, task.id, {
    workflowRunId: "pending:crashed-publisher",
    enqueueClaim: { token: "crashed-publisher", expiresAt: Date.now() - 1 },
  });
  const published: string[] = [];

  const report = await recoverQueuedTaskWorkflows(async (_ownerId, taskId) => {
    published.push(taskId);
    return "workflow-pending-recovered";
  }, { maxOwners: 10, maxTasksPerOwner: 20 });

  assert.equal(report.republished, 1);
  assert.deepEqual(published, [task.id]);
  const recovered = await getTask(userId, task.id);
  assert.equal(recovered?.workflowRunId, "workflow-pending-recovered");
  assert.equal(recovered?.enqueueClaim, undefined);
});

test("generic recovery never replays an expired running provider action", async () => {
  await initStore({ memoryOnly: true });
  const userId = 974003;
  const task = await createTask(userId, { title: "Do not replay", objective: "An external provider action is in flight.", runAt: Date.now() });
  const expiredAt = Date.now() - 1_000;
  await updateTask(userId, task.id, {
    status: "running",
    lease: { token: "expired-worker", workerId: "worker-a", acquiredAt: expiredAt - 1_000, expiresAt: expiredAt },
  });
  let publishes = 0;

  const report = await recoverQueuedTaskWorkflows(async () => {
    publishes += 1;
    return "must-not-publish";
  }, { maxOwners: 10, maxTasksPerOwner: 20 });

  assert.equal(publishes, 0);
  assert.equal(report.republished, 0);
  assert.equal(report.skipped, 1);
  assert.equal((await getTask(userId, task.id))?.status, "running");
});

test("generic recovery does not republish mission tasks or a live workflow", async () => {
  await initStore({ memoryOnly: true });
  const userId = 974004;
  const missionTask = await createTask(userId, { title: "Mission slice", objective: "Mission-owned work.", missionId: "mis_recovery_skip", runAt: Date.now() });
  const liveTask = await createTask(userId, { title: "Live workflow", objective: "Already handed off.", runAt: Date.now() });
  await setTaskWorkflowRunId(userId, liveTask.id, "workflow-live");
  const published: string[] = [];

  const report = await recoverQueuedTaskWorkflows(async (_ownerId, taskId) => {
    published.push(taskId);
    return "unexpected";
  }, { maxOwners: 10, maxTasksPerOwner: 20 });

  assert.deepEqual(published, []);
  assert.equal(report.checked, 1);
  assert.equal(report.skipped, 1);
  assert.equal((await getTask(userId, missionTask.id))?.workflowRunId, undefined);
  assert.equal((await getTask(userId, liveTask.id))?.workflowRunId, "workflow-live");
});

test("only one replica owns the generic recovery sweep at a time", async () => {
  await initStore({ memoryOnly: true });
  const userId = 974005;
  await createTask(userId, { title: "Lease guarded", objective: "Publish once.", runAt: Date.now() });
  let publishes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const enqueuer = async () => {
    publishes += 1;
    await held;
    return "workflow-lease-guarded";
  };

  const first = recoverQueuedTaskWorkflows(enqueuer, { maxOwners: 10, maxTasksPerOwner: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await recoverQueuedTaskWorkflows(async () => "duplicate", { maxOwners: 10, maxTasksPerOwner: 20 });
  release();
  const firstReport = await first;

  assert.equal(second.skippedDueToLock, true);
  assert.equal(firstReport.republished, 1);
  assert.equal(publishes, 1);
});
