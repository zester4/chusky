import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowAbort } from "@upstash/workflow";
import { isWorkflowControlFlow } from "../src/workflowControl.js";

test("recognizes Upstash workflow replay control flow without treating it as an application error", () => {
  assert.equal(isWorkflowControlFlow(new WorkflowAbort("durable-step")), true);
  assert.equal(isWorkflowControlFlow(new Error("ordinary failure")), false);
});
