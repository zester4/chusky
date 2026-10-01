import assert from "node:assert/strict";
import test from "node:test";
import { approvalRecoveryState } from "../chusky-web/lib/approval-recovery.js";

test("approval recovery allows retry only for a confirmed pending approval", () => {
  assert.equal(approvalRecoveryState("pending", "requires_approval"), "retry");
  assert.equal(approvalRecoveryState(undefined, undefined), "unknown");
  assert.equal(approvalRecoveryState("consumed", "requires_approval"), "accepted");
  assert.equal(approvalRecoveryState("approved", "requires_approval"), "accepted");
  assert.equal(approvalRecoveryState("denied", "requires_approval"), "denied");
});

test("persisted executing and terminal runs win over a lost approval response", () => {
  for (const status of ["running", "queued", "completed", "failed", "cancelled"] as const) {
    assert.equal(approvalRecoveryState("consumed", status), "run");
  }
});
