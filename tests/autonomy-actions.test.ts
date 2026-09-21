import test from "node:test";
import assert from "node:assert/strict";
import { beginExternalAction, finishExternalAction, isExternalWriteTool } from "../src/autonomy/actions.js";
import { initStore } from "../src/store.js";

test("autonomous external action receipts make successful provider writes idempotent", async () => {
  await initStore({ memoryOnly: true });
  const first = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { to: "a@example.com", subject: "Hello" }, runId: "run-1", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(first.state, "new");
  await finishExternalAction(950001, first.logicalActionId, '{"providerId":"msg_1"}');
  const replay = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { subject: "Hello", to: "a@example.com" }, runId: "run-retry", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(replay.state, "succeeded");
  assert.match(replay.receipt?.resultSummary ?? "", /providerId/);
});
test("external write classification leaves reads and checkpoints replay-safe", () => {
  assert.equal(isExternalWriteTool("GMAIL_SEND_EMAIL"), true);
  assert.equal(isExternalWriteTool("GMAIL_GET_MESSAGE"), false);
  assert.equal(isExternalWriteTool("CHUCK_TASK_CHECKPOINT"), false);
  assert.equal(isExternalWriteTool("CHUCK_SET_REMINDER"), true);
});
