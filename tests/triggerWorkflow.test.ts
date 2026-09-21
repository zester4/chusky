import test from "node:test";
import assert from "node:assert/strict";
import { taskWorkflowRunId } from "../src/triggerWorkflow.js";

test("task workflow publication uses a stable QStash idempotency key", () => {
  const first = taskWorkflowRunId("task_123", 1_800_000_000_000);
  const retry = taskWorkflowRunId("task_123", 1_800_000_000_000);
  const differentAttempt = taskWorkflowRunId("task_123", 1_800_000_001_000);
  assert.equal(first, "task-task_123-1800000000000");
  assert.equal(retry, first);
  assert.notEqual(differentAttempt, first);
});
