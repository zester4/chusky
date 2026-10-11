import test from "node:test";
import assert from "node:assert/strict";
import { ELENA_TOOL_SLUGS, isElenaApproval, isElenaToolSlug } from "../src/proactive/featureFlag.js";

test("the Elena tool boundary contains only Pulse capabilities", () => {
  assert.deepEqual([...ELENA_TOOL_SLUGS].sort(), [
    "CHUCK_ATTENTION_PULSE",
    "CHUCK_ATTENTION_STATE",
    "CHUCK_AUTONOMY_PLAYBOOK",
    "CHUCK_AUTONOMY_RECONCILE",
    "CHUCK_AUTONOMY_STATUS",
  ].sort());
  assert.equal(isElenaToolSlug("chuck_attention_pulse"), true);
  assert.equal(isElenaToolSlug("CHUCK_CREATE_TRIGGER"), false);
  assert.equal(isElenaToolSlug("CHUCK_TASK_CREATE"), false);
});

test("disabled dashboards hide Elena handoff approvals without hiding ordinary task approvals", () => {
  const elenaHandoffs = new Set(["handoff_elena"]);
  assert.equal(isElenaApproval({ toolSlug: "CHUCK_TASK_CHECKPOINT", handoffId: "handoff_elena" }, elenaHandoffs), true);
  assert.equal(isElenaApproval({ toolSlug: "CHUCK_TASK_CHECKPOINT", handoffId: "handoff_other" }, elenaHandoffs), false);
  assert.equal(isElenaApproval({ toolSlug: "CHUCK_ATTENTION_PULSE" }, elenaHandoffs), true);
});
