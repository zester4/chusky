import test from "node:test";
import assert from "node:assert/strict";
import { claimTaskEnqueue, createTask, getTask, initStore, recoverTaskAfterWorkflowFailure, setTaskWorkflowRunId, updateTask } from "../src/store.js";
import { enqueueTaskWithClaim } from "../src/taskEnqueue.js";
import { taskWorkflowRunId } from "../src/triggerWorkflow.js";

test("all task publishers share the durable claim protocol", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973001;
  const task = await createTask(userId, { title: "Publish", objective: "Publish once", runAt: Date.now() });
  let publishes = 0;
  const enqueuer = async () => { publishes += 1; return "workflow_once"; };
  assert.equal(await enqueueTaskWithClaim(userId, task.id, task.runAt ?? Date.now(), enqueuer), "workflow_once");
  assert.equal(await enqueueTaskWithClaim(userId, task.id, task.runAt ?? Date.now(), enqueuer), undefined);
  assert.equal(publishes, 1);
  assert.equal((await getTask(userId, task.id))?.workflowRunId, "workflow_once");
});

test("a failed task publication clears the pending claim for recovery", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973002;
  const task = await createTask(userId, { title: "Retry publish", objective: "Recover", runAt: Date.now() });
  await assert.rejects(() => enqueueTaskWithClaim(userId, task.id, task.runAt ?? Date.now(), async () => { throw new Error("provider unavailable"); }), /provider unavailable/);
  const recovered = await getTask(userId, task.id);
  assert.equal(recovered?.workflowRunId, undefined);
  assert.equal(recovered?.enqueueClaim, undefined);
});

test("publication fails loudly when the provider run ID cannot be recorded", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973003;
  const task = await createTask(userId, { title: "Unrecorded publish", objective: "Surface the race", runAt: Date.now() });
  let publishes = 0;
  await assert.rejects(
    () => enqueueTaskWithClaim(
      userId,
      task.id,
      task.runAt ?? Date.now(),
      async () => { publishes += 1; return "workflow_unrecorded"; },
      async () => undefined,
    ),
    /provider run ID could not be recorded/,
  );
  assert.equal(publishes, 1);
});

test("a terminal QStash failure republishes a due queued task with a fresh run ID", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973004;
  const task = await createTask(userId, { title: "Recover delivery", objective: "Resume after QStash failure", runAt: Date.now() - 1 });
  await setTaskWorkflowRunId(userId, task.id, "wfr_old-run");

  const recovery = await recoverTaskAfterWorkflowFailure(userId, task.id, "wfr_old-run");
  assert.equal(recovery?.shouldEnqueue, true);
  assert.equal(recovery?.task.workflowDeliveryFailures, 1);
  assert.equal(recovery?.task.workflowRunId, undefined);

  let publishedRunId = "";
  await enqueueTaskWithClaim(userId, task.id, recovery?.task.runAt ?? Date.now(), async (_userId, _taskId, runAt) => {
    publishedRunId = `wfr_recovery-${runAt}`;
    return publishedRunId;
  });
  assert.notEqual(publishedRunId, "wfr_old-run");
  assert.equal((await getTask(userId, task.id))?.workflowRunId, publishedRunId);
  assert.equal(await recoverTaskAfterWorkflowFailure(userId, task.id, "wfr_old-run"), undefined);
});

test("failure callback redelivery is idempotent when replacement publication failed", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973005;
  const task = await createTask(userId, { title: "Recover callback", objective: "Retry callback safely", runAt: Date.now() - 1 });
  await setTaskWorkflowRunId(userId, task.id, "wfr_callback-old");
  const first = await recoverTaskAfterWorkflowFailure(userId, task.id, "wfr_callback-old");
  assert.equal(first?.task.workflowDeliveryFailures, 1);

  await assert.rejects(() => enqueueTaskWithClaim(userId, task.id, first?.task.runAt ?? Date.now(), async () => { throw new Error("QStash unavailable"); }), /QStash unavailable/);
  const redelivery = await recoverTaskAfterWorkflowFailure(userId, task.id, "wfr_callback-old");
  assert.equal(redelivery?.shouldEnqueue, true);
  assert.equal(redelivery?.task.workflowDeliveryFailures, 1);
});

test("failure callback recovers an accepted publication whose run ID was not finalized", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973008;
  const task = await createTask(userId, { title: "Recover unfinalized publish", objective: "Close the publish-record crash window", runAt: Date.now() - 60_000 });
  await claimTaskEnqueue(userId, task.id, "pending-publish-token");
  const expectedRunId = `wfr_task-${task.id}-${task.runAt}`;

  const recovery = await recoverTaskAfterWorkflowFailure(userId, task.id, expectedRunId);
  assert.equal(recovery?.shouldEnqueue, true);
  assert.equal(recovery?.task.workflowRunId, undefined);
  assert.equal(recovery?.task.enqueueClaim, undefined);
  assert.equal(recovery?.task.workflowDeliveryFailures, 1);
});

test("stale workflow failure callbacks cannot clear a newer publication", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973006;
  const task = await createTask(userId, { title: "Keep current run", objective: "Reject stale callback", runAt: Date.now() - 1 });
  await setTaskWorkflowRunId(userId, task.id, "wfr_current");

  assert.equal(await recoverTaskAfterWorkflowFailure(userId, task.id, "wfr_old"), undefined);
  assert.equal((await getTask(userId, task.id))?.workflowRunId, "wfr_current");
});

test("workflow delivery failures stop after three consecutive failures", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973007;
  const task = await createTask(userId, { title: "Bound delivery failures", objective: "Do not retry forever", runAt: Date.now() - 1 });
  let currentRunId = "wfr_delivery-0";
  await setTaskWorkflowRunId(userId, task.id, currentRunId);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await recoverTaskAfterWorkflowFailure(userId, task.id, currentRunId);
    assert.ok(result);
    if (attempt < 3) {
      assert.equal(result.task.status, "queued");
      currentRunId = `wfr_delivery-${attempt}`;
      await setTaskWorkflowRunId(userId, task.id, currentRunId);
      // Failure recovery advances runAt by one millisecond to generate a new
      // singleton workflow ID. Let that retry become due before simulating
      // the next terminal callback.
      await new Promise((resolve) => setTimeout(resolve, 2));
    } else {
      assert.equal(result.task.status, "failed");
      assert.equal(result.shouldEnqueue, false);
    }
  }
});

test("stale published workflow recovery creates a new singleton run ID", async () => {
  await initStore({ memoryOnly: true });
  const userId = 973009;
  const originalRunAt = Date.now() - 120_000;
  const task = await createTask(userId, { title: "Replace stale workflow", objective: "Wake a stranded task", runAt: originalRunAt });
  await setTaskWorkflowRunId(userId, task.id, taskWorkflowRunId(task.id, originalRunAt));
  await updateTask(userId, task.id, { workflowPublishedAt: Date.now() - 120_000 });

  let publishedRunAt = 0;
  let publishedWorkflowRunId = "";
  await enqueueTaskWithClaim(userId, task.id, originalRunAt, async (_ownerId, taskId, runAt) => {
    publishedRunAt = runAt;
    publishedWorkflowRunId = taskWorkflowRunId(taskId, runAt);
    return `wfr_${publishedWorkflowRunId}`;
  });

  assert.ok(publishedRunAt > originalRunAt);
  assert.notEqual(publishedWorkflowRunId, taskWorkflowRunId(task.id, originalRunAt));
  assert.equal((await getTask(userId, task.id))?.runAt, publishedRunAt);
  assert.equal((await getTask(userId, task.id))?.workflowRunId, `wfr_${publishedWorkflowRunId}`);
});
