import test from "node:test";
import assert from "node:assert/strict";
import { beginExternalAction, externalArgumentsHash, failExternalAction, finishExternalAction, isExternalWriteTool, reconcileExternalActionByRead, repairMissionEvidenceForMission } from "../src/autonomy/actions.js";
import { completeMissionStep, createMission, getExternalAction, getMission, initStore, saveExternalAction, startMission } from "../src/store.js";

test("autonomous external action receipts make successful provider writes idempotent", async () => {
  await initStore({ memoryOnly: true });
  const first = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { to: "a@example.com", subject: "Hello" }, runId: "run-1", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(first.state, "new");
  await finishExternalAction(950001, first.logicalActionId, '{"providerId":"msg_1"}');
  const replay = await beginExternalAction({ userId: 950001, provider: "composio", tool: "GMAIL_SEND_EMAIL", args: { subject: "Hello", to: "a@example.com" }, runId: "run-retry", source: { kind: "job", id: "job_1", occurrenceId: "occ_1" } });
  assert.equal(replay.state, "succeeded");
  assert.match(replay.receipt?.resultSummary ?? "", /providerId/);
});

test("trigger external action receipts prevent duplicate writes after workflow replay", async () => {
  await initStore({ memoryOnly: true });
  const input = {
    userId: 950006,
    provider: "composio" as const,
    tool: "GMAIL_SEND_EMAIL",
    args: { to: "owner@example.com", subject: "Trigger update" },
    runId: "trigger-agent-event-1",
    source: { kind: "trigger", id: "evt_replayed_1" },
  };
  const first = await beginExternalAction(input);
  assert.equal(first.state, "new");
  await finishExternalAction(input.userId, first.logicalActionId, "provider accepted the message", "msg_trigger_1");

  const replay = await beginExternalAction({ ...input, runId: "trigger-agent-event-1-retry" });
  assert.equal(replay.state, "succeeded");
  assert.equal(replay.receipt?.providerId, "msg_trigger_1");
});

test("mission external action idempotency is scoped to the exact mission step", async () => {
  await initStore({ memoryOnly: true });
  const args = { to: "randy@example.com", subject: "Appointment" };
  const first = await beginExternalAction({
    userId: 950009,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args,
    runId: "mission-step-a-run",
    source: { kind: "mission", id: "mis_same_action", missionStepId: "step-a" },
  });
  assert.equal(first.state, "new");
  await finishExternalAction(950009, first.logicalActionId, "sent in step A", "msg-a");

  const second = await beginExternalAction({
    userId: 950009,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args,
    runId: "mission-step-b-run",
    source: { kind: "mission", id: "mis_same_action", missionStepId: "step-b" },
  });
  assert.equal(second.state, "new", "a distinct mission step must not reuse step A receipt");
  assert.notEqual(second.logicalActionId, first.logicalActionId);
  await finishExternalAction(950009, second.logicalActionId, "sent in step B", "msg-b");

  const replay = await beginExternalAction({
    userId: 950009,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args,
    runId: "mission-step-b-retry",
    source: { kind: "mission", id: "mis_same_action", missionStepId: "step-b" },
  });
  assert.equal(replay.state, "succeeded");
  assert.equal(replay.receipt?.providerId, "msg-b");
});

test("mission action keys read compatible legacy receipts only for the same step", async () => {
  await initStore({ memoryOnly: true });
  const args = { to: "legacy@example.com", subject: "Legacy appointment" };
  const argumentsHash = externalArgumentsHash(args);
  const legacyLogicalActionId = ["mission", "mis_legacy_key", "single", "GMAIL_SEND_EMAIL", argumentsHash].join(":").slice(0, 240);
  await saveExternalAction({
    id: "act_legacy_key",
    userId: 950010,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    argumentsHash,
    logicalActionId: legacyLogicalActionId,
    sourceKind: "mission",
    sourceId: "mis_legacy_key",
    missionStepId: "send-email",
    status: "succeeded",
    providerId: "legacy-msg-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const sameStep = await beginExternalAction({
    userId: 950010,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args,
    runId: "legacy-retry",
    source: { kind: "mission", id: "mis_legacy_key", missionStepId: "send-email" },
  });
  assert.equal(sameStep.state, "succeeded");
  assert.equal(sameStep.logicalActionId, legacyLogicalActionId);

  const differentStep = await beginExternalAction({
    userId: 950010,
    provider: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args,
    runId: "legacy-different-step",
    source: { kind: "mission", id: "mis_legacy_key", missionStepId: "other-step" },
  });
  assert.equal(differentStep.state, "new");
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

test("an ambiguous external action is promoted only by fresh read-back and cannot be downgraded", async () => {
  await initStore({ memoryOnly: true });
  const input = { userId: 950004, provider: "composio" as const, tool: "HUBSPOT_UPDATE_CONTACT", args: { id: "contact_1", status: "qualified" }, runId: "run-readback", source: { kind: "job", id: "job_readback", occurrenceId: "occ_1" } };
  const claim = await beginExternalAction(input);
  await failExternalAction(input.userId, claim.logicalActionId, "response timed out after dispatch");
  const verified = await reconcileExternalActionByRead({ userId: input.userId, logicalActionId: claim.logicalActionId, evidenceRef: "composio-read:HUBSPOT_GET_CONTACT:hash:1000", summary: "Contact status is qualified.", verifiedAt: 1000 });
  assert.equal(verified?.status, "succeeded");
  assert.equal(verified?.receiptVerification, "provider_read");
  assert.match(verified?.receiptEvidenceRef ?? "", /^composio-read:/);
  await failExternalAction(input.userId, claim.logicalActionId, "a late timeout report cannot erase read-back proof");
  assert.equal((await getExternalAction(input.userId, claim.logicalActionId))?.status, "succeeded");
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

test("successful batched provider actions create per-action trusted receipt evidence", async () => {
  await initStore({ memoryOnly: true });
  const userId = 950005;
  const mission = await createMission(userId, {
    title: "Batch receipts",
    objective: "Record each confirmed provider action",
    definitionOfDone: "Each provider action has a trusted receipt",
    requiredEvidence: ["kind:tool_receipt"],
  });
  const started = await startMission(userId, mission.id);
  assert.ok(started?.currentStepId);
  const batchArgs = { tools: [{ tool_slug: "GOOGLESHEETS_UPDATE_VALUES_BATCH", arguments: { spreadsheet_id: "sheet-1", range: "Sheet1!A1:B3" } }] };
  const claim = await beginExternalAction({
    userId,
    provider: "composio",
    tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
    args: batchArgs,
    runId: "mission-batch-run",
    source: { kind: "mission", id: mission.id, missionStepId: started!.currentStepId },
  });
  await finishExternalAction(userId, claim.logicalActionId, "batch confirmed", "batch-log-1", [{
    toolSlug: "GOOGLESHEETS_UPDATE_VALUES_BATCH",
    index: 0,
    argumentsHash: "args-hash-1",
  }]);
  const evidence = (await getMission(userId, mission.id))?.evidence ?? [];
  const providerEvidence = evidence.find((item) => item.source === "GOOGLESHEETS_UPDATE_VALUES_BATCH");
  assert.equal(providerEvidence?.verifiedBy, "system");
  assert.equal(providerEvidence?.verified, true);
  assert.match(providerEvidence?.ref ?? "", /^tool-receipt:.*:0$/);
});

test("mission recovery repairs trusted evidence without replaying a succeeded provider action", async () => {
  await initStore({ memoryOnly: true });
  const userId = 950007;
  const mission = await createMission(userId, {
    title: "Repair interrupted proof",
    objective: "Preserve provider proof after a worker interruption",
    definitionOfDone: "The provider receipt is attached to the mission",
    requiredEvidence: ["kind:tool_receipt"],
  });
  const started = await startMission(userId, mission.id);
  assert.ok(started?.currentStepId);
  const claim = await beginExternalAction({
    userId,
    provider: "composio",
    tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
    args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } }] },
    runId: "mission-proof-repair",
    source: { kind: "mission", id: mission.id, missionStepId: started!.currentStepId },
  });
  assert.equal(claim.state, "new");
  assert.ok(claim.receipt);
  // Model the real crash window: the provider succeeded and the receipt was
  // durable, but the mission evidence mutation did not finish.
  await saveExternalAction({
    ...claim.receipt!,
    status: "succeeded",
    providerId: "batch-proof-1",
    missionEvidenceStatus: "failed",
    missionEvidenceError: "worker interrupted after provider success",
    providerActions: [{ toolSlug: "GMAIL_SEND_EMAIL", argumentsHash: "hash-1", index: 0 }],
  });
  const repaired = await repairMissionEvidenceForMission(userId, mission.id);
  assert.equal(repaired, 1);
  const receipt = await getExternalAction(userId, claim.logicalActionId);
  assert.equal(receipt?.missionEvidenceStatus, "persisted");
  const evidence = (await getMission(userId, mission.id))?.evidence ?? [];
  assert.ok(evidence.some((item) => item.source === "GMAIL_SEND_EMAIL"));
  assert.equal((await beginExternalAction({
    userId,
    provider: "composio",
    tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
    args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } }] },
    runId: "mission-proof-retry",
    source: { kind: "mission", id: mission.id, missionStepId: started!.currentStepId },
  })).state, "succeeded");
});

test("a missing durable receipt cannot be acknowledged as a completed external action", async () => {
  await initStore({ memoryOnly: true });
  assert.equal(await finishExternalAction(950008, "missing-action", "provider accepted"), undefined);
});
