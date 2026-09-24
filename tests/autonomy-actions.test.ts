import test from "node:test";
import assert from "node:assert/strict";
import { beginExternalAction, failExternalAction, finishExternalAction, isExternalWriteTool } from "../src/autonomy/actions.js";
import { completeMissionStep, createMission, getMission, initStore, startMission } from "../src/store.js";

test("autonomous external action receipts make successful provider writes idempotent", async () => {
  await initStore({ memoryOnly: true });
  const first = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { to: "a@example.com", subject: "Hello" }, runId: "run-1", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(first.state, "new");
  await finishExternalAction(950001, first.logicalActionId, '{"providerId":"msg_1"}');
  const replay = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { subject: "Hello", to: "a@example.com" }, runId: "run-retry", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(replay.state, "succeeded");
  assert.match(replay.receipt?.resultSummary ?? "", /providerId/);
});

test("an uncertain external-write failure is quarantined instead of replayed", async () => {
  await initStore({ memoryOnly: true });
  const input = { userId: 950003, provider: "composio" as const, tool: "GMAIL_SEND_EMAIL", args: { to: "a@example.com", subject: "May already have sent" }, runId: "run-ambiguous", source: { kind: "mission", id: "mis_ambiguous", missionStepId: "send" } };
  const first = await beginExternalAction(input);
  assert.equal(first.state, "new");
  await failExternalAction(input.userId, first.logicalActionId, "Provider response was lost after request submission");

  const retry = await beginExternalAction({ ...input, runId: "run-retry" });
  assert.equal(retry.state, "ambiguous");
  assert.match(retry.receipt?.error ?? "", /verify.*provider|provider.*verify/i);
});
test("external write classification leaves reads and checkpoints replay-safe", () => {
  assert.equal(isExternalWriteTool("GMAIL_SEND_EMAIL"), true);
  assert.equal(isExternalWriteTool("GMAIL_GET_MESSAGE"), false);
  assert.equal(isExternalWriteTool("CHUCK_TASK_CHECKPOINT"), false);
  assert.equal(isExternalWriteTool("CHUCK_TASK_RETRY"), false);
  assert.equal(isExternalWriteTool("CHUCK_MISSION_RESUME"), false);
  assert.equal(isExternalWriteTool("CHUCK_SET_REMINDER"), true);
});

test("successful mission external writes create server-trusted receipt evidence", async () => {
  await initStore({ memoryOnly: true });
  const userId = 950002;
  const mission = await createMission(userId, {
    title: "Send approved update",
    objective: "Send one approved update",
    definitionOfDone: "The update was sent",
    requiredEvidence: ["kind:tool_receipt"],
  });
  const started = await startMission(userId, mission.id);
  assert.ok(started?.currentStepId);
  const claim = await beginExternalAction({
    userId,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args: { to: "a@example.com", subject: "Approved" },
    runId: "mission-run-1",
    source: { kind: "mission", id: mission.id, missionStepId: started!.currentStepId },
  });
  assert.equal(claim.state, "new");
  await finishExternalAction(userId, claim.logicalActionId, "sent", "msg_2");
  const afterReceipt = await getMission(userId, mission.id);
  const evidence = afterReceipt?.evidence?.find((item) => item.kind === "tool_receipt");
  assert.equal(evidence?.verifiedBy, "system");
  assert.equal(evidence?.verified, true);
  assert.match(evidence?.ref ?? "", /^tool-receipt:/);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Sent");
});
