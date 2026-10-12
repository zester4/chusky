import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskWorkflowPayload } from "../src/workflows.js";

test("task workflow payload parser accepts only bounded task IDs and positive owner IDs", () => {
  assert.deepEqual(parseTaskWorkflowPayload({ taskId: "task_abc-123", userId: 42 }), { taskId: "task_abc-123", userId: 42 });
  for (const payload of [
    null,
    "task_abc",
    { taskId: "", userId: 42 },
    { taskId: "task/../other", userId: 42 },
    { taskId: "task_abc", userId: 0 },
    { taskId: "task_abc", userId: 1.5 },
    { taskId: "task_abc", userId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => parseTaskWorkflowPayload(payload));
  }
});
