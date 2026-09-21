import test from "node:test";
import assert from "node:assert/strict";
import { createTask, getTask, initStore } from "../src/store.js";
import { enqueueTaskWithClaim } from "../src/taskEnqueue.js";

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
