import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowAbort } from "@upstash/workflow";
import { isWorkflowControlFlow } from "../src/workflowControl.js";
import { isValidWorkflowEventId, workflowEventId } from "../src/workflowIds.js";

test("recognizes Upstash workflow replay control flow without treating it as an application error", () => {
  assert.equal(isWorkflowControlFlow(new WorkflowAbort("durable-step")), true);
  assert.equal(isWorkflowControlFlow(new Error("ordinary failure")), false);
});

test("builds Upstash-safe event IDs without colon punctuation", () => {
  const eventId = workflowEventId("subagent-tools", "handoff_123", 2);
  assert.equal(eventId, "subagent-tools-handoff_123-2");
  assert.equal(isValidWorkflowEventId(eventId), true);
  assert.equal(isValidWorkflowEventId("subagent-tools:handoff_123:2"), false);
});
