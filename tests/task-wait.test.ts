import test from "node:test";
import assert from "node:assert/strict";
import { createTask, getTask, initStore } from "../src/store.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { createTaskWaitRequest } from "../src/taskWait.js";

test("internal task wait requests a one-time continuation without delivery", () => {
  const request = createTaskWaitRequest({
    delaySeconds: 120,
    checkpoint: "Submitted the export job and recorded its provider request ID.",
    nextAction: "Check the export status using the saved provider request ID, then download it if ready.",
    reason: "The provider reports that the export is still processing.",
  });

  assert.ok(request.runAt > Date.now());
  assert.ok(request.runAt <= Date.now() + 121_000);
  assert.equal(request.checkpoint, "Submitted the export job and recorded its provider request ID.");
  assert.equal(request.reason, "The provider reports that the export is still processing.");
});

test("internal task wait requires a bounded future time", async () => {
  await assert.rejects(
    () => Promise.resolve().then(() => createTaskWaitRequest({ checkpoint: "x", nextAction: "y" })),
    /requires delaySeconds or runAt/i,
  );
  await assert.rejects(
    () => Promise.resolve().then(() => createTaskWaitRequest({ delaySeconds: 30, checkpoint: "x", nextAction: "y" })),
    /at least 60 seconds/i,
  );
});

test("queued task outcomes retain their wake-up time and checkpoint", async () => {
  await initStore({ memoryOnly: true });
  const userId = 850003;
  const task = await createTask(userId, { title: "Poll export", objective: "Wait for an export and continue", maxAttempts: 1 });
  const runAt = Date.now() + 5 * 60_000;
  const run = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "task-wait-test",
    execute: async () => ({
      status: "queued" as const,
      message: "Waiting for the provider export",
      runAt,
      checkpoint: "Export request accepted",
      nextAction: "Check export status",
    }),
  });

  assert.equal(run.task?.status, "queued");
  assert.equal(run.task?.runAt, runAt);
  assert.equal(run.task?.checkpoint, "Export request accepted");
  assert.equal(run.task?.nextAction, "Check export status");
  assert.equal((await getTask(userId, task.id))?.events.at(-1)?.type, "retried");
});
