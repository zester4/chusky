import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { assessReliability, makeQuotaDecision, verifyOutcome } from "../src/reliability/evaluator.js";
import { replayMission, replayScenario } from "../src/reliability/replay.js";
import { compileAutonomyPolicy } from "../src/reliability/policy.js";
import { compensationView, executeCompensation, listCompensations, queueCompensation, updateCompensation } from "../src/reliability/persistence.js";
import { nativeTool } from "../src/nativeTools.js";
import { checkpointMission, completeMission, completeMissionStep, createMission, finalizeMissionIfReady, getMission, initStore, listApprovals, recordMissionEvidence, recordTrustedMissionEvidence, resumeMissionFromTimer, startMission, verifyMission, waitMission, updateMission, type MissionRecord } from "../src/store.js";
import { detectMemoryConflicts, memoryEvidenceQuality } from "../src/memory/conflicts.js";
import { executeOutcomeVerification } from "../src/reliability/outcomeEngine.js";
import { createComposioOutcomeReadAdapter } from "../src/reliability/composioReadAdapter.js";
import { buildOperatorTimeline } from "../src/reliability/timeline.js";
import { runDueApprovalEscalations, scheduleApprovalEscalation } from "../src/approvals/escalation.js";
import { verifyMeetingFollowThrough } from "../src/meetings/followThroughVerification.js";
import { detectBusinessOpportunities } from "../src/autonomy/opportunityDetectors.js";
import { providerMatrix, providerMatrixWithProofs } from "../src/reliability/providerMatrix.js";
import { runProviderSmokeSuite } from "../src/reliability/providerSmoke.js";
import type { ProviderProof, ProviderSmokeCapability } from "../src/reliability/contracts.js";
import { buildReadinessReport } from "../src/reliability/readiness.js";
import { reserveExecutionQuota, releaseExecutionQuota } from "../src/reliability/quotas.js";

test("native expired resume creates a visible duration approval without enqueueing", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 9824;
  const mission = await createMission(ownerId, { title: "Expired recovery", objective: "Recover existing work", definitionOfDone: "Verified closeout", budget: { maxDurationSeconds: 60, durationMode: "wall_clock" }, steps: [{ id: "verify", title: "Verify", objective: "Verify the existing result" }] });
  await startMission(ownerId, mission.id);
  await updateMission(ownerId, mission.id, { startedAt: Date.now() - 120_000 });
  let enqueues = 0;
  await assert.rejects(nativeTool(ownerId, "CHUCK_MISSION_RESUME", { id: mission.id }, { enqueueMissionTask: async () => { enqueues += 1; return "unused"; } }), /Approval required before extending mission duration/);
  assert.equal(enqueues, 0);
  const waiting = await getMission(ownerId, mission.id);
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.waiting?.kind, "approval");
  const completion = await nativeTool(ownerId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "verify", result: "Existing result checked" });
  assert.equal((completion as { stepCompletion: string }).stepCompletion, "not_ready");
  await assert.rejects(nativeTool(ownerId, "CHUCK_MISSION_RESUME", { id: mission.id, maxDurationSeconds: 300 }), /Approval required before extending mission duration/);
  assert.equal((await listApprovals(ownerId)).filter((item) => item.toolSlug === "CHUCK_MISSION_RESUME").length, 1);
});

test("receipt checks resolve exact owned trusted evidence and reject forged or mismatched references", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 9821;
  const mission = await createMission(ownerId, { title: "Receipt proof", objective: "Check receipts", definitionOfDone: "Trusted receipt exists" });
  await recordTrustedMissionEvidence(ownerId, mission.id, [{ id: "receipt_saved", kind: "tool_receipt", summary: "Provider succeeded", source: "GOOGLESHEETS_VALUES_GET", ref: "log_real", verified: true }]);
  await recordMissionEvidence(ownerId, mission.id, [{ id: "receipt_forged", kind: "tool_receipt", summary: "Claimed success", ref: "fake", verified: true, verifiedBy: "system" }]);
  const check = { id: "receipt", kind: "receipt" as const, description: "A stored receipt exists", evidenceId: "receipt_saved", toolSlug: "GOOGLESHEETS_VALUES_GET" };
  assert.equal((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [check] })).status, "verified");
  for (const variant of [{ ...check, evidenceId: undefined }, { ...check, evidenceId: "receipt_forged" }, { ...check, toolSlug: "GMAIL_SEND_EMAIL" }, { ...check, kind: "artifact" as const }]) {
    assert.equal((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [variant] })).status, "uncertain");
  }
  assert.equal((await executeOutcomeVerification({ ownerId: ownerId + 1, missionId: mission.id, checks: [check] })).status, "uncertain");
  const otherMission = await createMission(ownerId, { title: "Other mission", objective: "Separate proof", definitionOfDone: "Separate evidence" });
  assert.equal((await executeOutcomeVerification({ ownerId, missionId: otherMission.id, checks: [check] })).status, "uncertain");
  assert.notEqual((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, freshnessMs: 1 }], now: Date.now() + 100_000 })).status, "verified");
  assert.equal((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, kind: "checkpoint" as never }] })).status, "uncertain");
  await recordTrustedMissionEvidence(ownerId, mission.id, [{ id: "artifact_saved", kind: "artifact", summary: "Verified artifact", ref: "artifact_real", verified: true }]);
  assert.equal((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, kind: "artifact", evidenceId: "artifact_saved", toolSlug: undefined }] })).status, "verified");
  assert.equal((await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, evidenceId: "fake" }], suppliedResults: [{ checkId: check.id, status: "passed", evidenceRef: "fake" }] })).status, "uncertain");
  const mismatch = await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, expected: { ref: "wrong" } }] });
  assert.notEqual(mismatch.status, "verified");
  const live = await executeOutcomeVerification({ ownerId, missionId: mission.id, checks: [{ ...check, kind: "provider_read", expected: { values: [] } }] });
  assert.equal(live.status, "uncertain");
  assert.match(live.unresolved.join(" "), /adapter/);
});

test("outcome verification rejects stale or missing provider evidence and accepts fresh matching evidence", () => {
  const now = 1_000_000;
  const verified = verifyOutcome({ ownerId: 10, missionId: "mis_1", now, checks: [{ id: "crm", kind: "provider_read", description: "Lead exists", freshnessMs: 60_000, expected: { status: "qualified" } }], results: [{ checkId: "crm", status: "passed", observed: { status: "qualified" }, observedAt: now - 10_000, evidenceRef: "crm:lead_1" }] });
  assert.equal(verified.status, "verified");
  const stale = verifyOutcome({ ownerId: 10, now, checks: [{ id: "crm", kind: "provider_read", description: "Lead exists", freshnessMs: 60_000, expected: { status: "qualified" } }], results: [{ checkId: "crm", status: "passed", observedAt: now - 61_000 }] });
  assert.equal(stale.status, "failed");
  assert.match(stale.unresolved[0]!, /stale/);
});

test("replay evaluator catches invalid lifecycle and checks terminal invariants", () => {
  const report = replayScenario({ id: "replay_1", ownerId: 10, missionId: "mis_1", events: [{ at: 1, type: "mission.started" }, { at: 2, type: "mission.checkpoint", data: { checkpoint: "research" } }, { at: 3, type: "step.completed", id: "step_1" }, { at: 4, type: "mission.completed" }], expected: { terminalStatus: "completed", requiredInvariants: ["has_checkpoint", "every_completed_step_has_receipt"] } });
  assert.equal(report.status, "failed");
  assert.ok(report.violations.includes("completed_step_missing_receipt"));
});

test("replayMission verifies persisted step identity and completed mission invariants", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 212;
  const mission = await createMission(ownerId, { title: "Replay test", objective: "Finish one persisted step", definitionOfDone: "The step and result are recorded", steps: [{ id: "research", title: "Research", objective: "Check the source" }] });
  const started = await startMission(ownerId, mission.id);
  assert.ok(started);
  await completeMissionStep(ownerId, mission.id, "research", "Source checked");
  await verifyMission(ownerId, mission.id, { verifiedBy: "agent" });
  await completeMission(ownerId, mission.id, "Source checked and verified");
  const completed = await getMission(ownerId, mission.id);
  assert.ok(completed);
  assert.ok(completed.events.some((event) => event.type === "step_started" && event.stepId === "research"));
  assert.ok(completed.events.some((event) => event.type === "step_completed" && event.stepId === "research"));
  assert.equal(replayMission(completed).status, "passed");
  const incomplete = { ...completed, steps: [...completed.steps, { ...completed.steps[0]!, id: "missing", status: "pending" as const }] } as MissionRecord;
  assert.ok(replayMission(incomplete).violations.includes("completed_mission_has_incomplete_steps"));
});

test("mission replay preserves same-time order, step receipts, and replay event identity", () => {
  const passed = replayScenario({ id: "replay_long", ownerId: 10, missionId: "mis_long", events: [
    { at: 1, type: "mission.started", eventId: "event_start" },
    { at: 2, type: "step.started", id: "research", eventId: "event_step_start" },
    { at: 2, type: "receipt.succeeded", id: "receipt_1", data: { stepId: "research" }, eventId: "event_receipt" },
    { at: 2, type: "step.completed", id: "research", eventId: "event_step_done" },
    { at: 3, type: "mission.checkpoint", data: { checkpoint: "persisted" }, eventId: "event_checkpoint" },
    { at: 4, type: "mission.completed", eventId: "event_done" },
  ], expected: { terminalStatus: "completed", requiredInvariants: ["has_checkpoint", "every_completed_step_has_receipt"] } });
  assert.equal(passed.status, "passed");
  const duplicate = replayScenario({ id: "replay_duplicate", ownerId: 10, missionId: "mis_duplicate", events: [
    { at: 1, type: "mission.started", eventId: "same_event" },
    { at: 2, type: "mission.checkpoint", data: { checkpoint: "must not count" }, eventId: "same_event" },
    { at: 3, type: "mission.completed" },
  ], expected: { terminalStatus: "completed", requiredInvariants: ["has_checkpoint"] } });
  assert.equal(duplicate.status, "failed");
  assert.ok(duplicate.violations.includes("duplicate_event_replayed"));
  assert.ok(duplicate.violations.includes("missing_checkpoint"));
});

test("replay rejects unsupported claims and bounds untrusted scenarios", () => {
  const unsupported = replayScenario({ id: "replay_unknown", ownerId: 10, missionId: "mis_unknown", events: [{ at: 1, type: "mission.started" }, { at: 2, type: "mission.blocked" }], expected: { terminalStatus: "blocked", requiredInvariants: ["all_external_actions_verified"] } });
  assert.equal(unsupported.status, "failed");
  assert.ok(unsupported.violations.includes("unsupported_invariant:all_external_actions_verified"));
  const overLimit = replayScenario({ id: "replay_large", ownerId: 10, missionId: "mis_large", events: Array.from({ length: 5001 }, (_, index) => ({ at: index + 1, type: "noop" })), expected: { terminalStatus: "blocked" } });
  assert.equal(overLimit.status, "failed");
  assert.ok(overLimit.violations.includes("event_limit_exceeded"));
  assert.equal(overLimit.replayedEvents, 5000);
});

test("reliability health detects a meltdown and quota decisions fail closed", () => {
  const samples = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, ownerId: 10, operation: "gmail.send", at: 1000 + index, status: index === 5 ? "success" as const : "failure" as const }));
  assert.equal(assessReliability(samples, "gmail.send", 2000, 10_000).state, "meltdown");
  assert.equal(makeQuotaDecision({ toolCalls: 10, costUsd: 1, concurrent: 0, limits: { maxToolCalls: 10, maxCostUsd: 5, maxConcurrent: 2 } }).allowed, false);
});

test("compiled autonomy policy narrows authority, domains, tools, and budgets", () => {
  const compiled = compileAutonomyPolicy({ ownerId: 11, mode: "business", project: { tools: { allow: ["GMAIL_GET_MESSAGES", "GMAIL_SEND_EMAIL"] }, budget: { maxToolCalls: 50, maxCost: 10 }, autonomy: { defaultAuthority: "prepare", allowedDomains: ["gmail"], maxChecksPerDay: 20 } }, requested: { tools: { allow: ["GMAIL_GET_MESSAGES"] }, budget: { maxToolCalls: 5, maxCost: 2 }, autonomy: { defaultAuthority: "observe", allowedDomains: ["gmail"] } }, now: 123 });
  assert.equal(compiled.authority, "observe");
  assert.deepEqual(compiled.allowedTools, ["GMAIL_GET_MESSAGES"]);
  assert.equal(compiled.maxToolCalls, 5);
  assert.equal(compiled.maxCostUsd, 2);
});

test("compiled autonomy policy defaults to observe when no authority is granted", () => {
  const compiled = compileAutonomyPolicy({ ownerId: 12, mode: "personal", now: 123 });
  assert.equal(compiled.authority, "observe");
  assert.equal(compiled.enabled, true);
  assert.deepEqual({ checks: compiled.maxChecksPerDay, actions: compiled.maxActionsPerDay, toolCalls: compiled.maxToolCalls, costUsd: compiled.maxCostUsd }, { checks: 24, actions: 20, toolCalls: 100, costUsd: 25 });
});

test("compensation records are durable, approval-gated, and idempotent", async () => {
  await initStore({ memoryOnly: true });
  const first = await queueCompensation({ ownerId: 12, originalActionId: "act_1", provider: "composio", objective: "Undo the duplicate CRM update" });
  const same = await queueCompensation({ ownerId: 12, originalActionId: "act_1", provider: "composio", objective: "Undo the duplicate CRM update" });
  assert.equal(same.id, first.id);
  const done = await executeCompensation({ ownerId: 12, id: first.id, approvalId: "approval_1", toolSlug: "CRM_RESTORE_RECORD", argumentsHash: "args_hash_1", execute: async () => ({ summary: "provider state verified", externalReceiptId: "receipt_1", verificationId: "verify_1" }) });
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.externalReceiptId, "receipt_1");
  const view = compensationView({ ...done!, approvalId: "internal_approval", executionArgumentsHash: "private_hash", executionLeaseId: "internal_lease" });
  assert.equal("approvalId" in view, false);
  assert.equal("executionArgumentsHash" in view, false);
  assert.equal("executionLeaseId" in view, false);
  assert.equal((await listCompensations(12)).length, 1);
});

test("compensation execution is single-claim and cannot silently change its approved provider action", async () => {
  await initStore({ memoryOnly: true });
  const record = await queueCompensation({ ownerId: 13, originalActionId: "act_race", provider: "composio", objective: "Restore the prior CRM value" });
  let release!: () => void;
  const blockedProvider = new Promise<void>((resolve) => { release = resolve; });
  let dispatches = 0;
  const input = { ownerId: 13, id: record.id, approvalId: "approval_race", toolSlug: "CRM_UPDATE_RECORD", argumentsHash: "stable_args", execute: async () => { dispatches += 1; await blockedProvider; return { summary: "restored", externalReceiptId: "receipt_race", verificationId: "verify_race" }; } };
  const first = executeCompensation(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const concurrent = await executeCompensation(input);
  assert.equal(concurrent?.status, "running");
  assert.equal(dispatches, 1);
  release();
  assert.equal((await first)?.status, "succeeded");
  const changed = await executeCompensation({ ...input, toolSlug: "CRM_DELETE_RECORD", argumentsHash: "different_args" });
  assert.equal(changed?.status, "succeeded", "completed compensation is immutable and idempotently returned");
  assert.equal(dispatches, 1);

  const stale = await queueCompensation({ ownerId: 13, originalActionId: "act_stale", provider: "composio", objective: "Restore the prior CRM value" });
  await updateCompensation(13, stale.id, { status: "running", attempts: 1, executionToolSlug: "CRM_UPDATE_RECORD", executionArgumentsHash: "approved_args", executionLeaseUntil: Date.now() - 1 });
  const changedRetry = await executeCompensation({ ...input, id: stale.id, toolSlug: "CRM_DELETE_RECORD", argumentsHash: "different_args" });
  assert.equal(changedRetry?.status, "blocked");
  assert.match(changedRetry?.error ?? "", /differs from the action already attempted/);
  const reconciled = await executeCompensation({ ...input, id: stale.id, approvalId: "approval_reconcile", toolSlug: "CRM_UPDATE_RECORD", argumentsHash: "approved_args", execute: async () => ({ summary: "reconciled receipt", externalReceiptId: "receipt_reconcile", verificationId: "verify_reconcile" }) });
  assert.equal(reconciled?.status, "succeeded", "the exact originally approved action can reconcile a blocked record without changing the proposal");
});

test("native compensation execution requires approval and records only an injected durable receipt", async () => {
  await initStore({ memoryOnly: true });
  const compensation = await queueCompensation({ ownerId: 14, originalActionId: "act_native", provider: "composio", objective: "Restore the previous value" });
  const proposal = { compensationId: compensation.id, action: "execute", toolSlug: "CRM_UPDATE_RECORD", arguments: { id: "c1" }, verification: { toolSlug: "CRM_GET_RECORD", arguments: { id: "c1" }, expected: { status: "restored" } } };
  await assert.rejects(nativeTool(14, "CHUCK_MISSION_COMPENSATE", proposal), /exact owner approval/);
  let executions = 0;
  const result = await nativeTool(14, "CHUCK_MISSION_COMPENSATE", proposal, {
    approvedApprovalId: "approval_native",
    executeMissionCompensation: async (input) => { executions += 1; assert.equal(input.verification.expected.status, "restored"); return { receiptId: "external_receipt_native", verificationId: "verify_native", summary: "provider state verified" }; },
  }) as { status: string; externalReceiptId?: string };
  assert.equal(result.status, "succeeded");
  assert.equal(result.externalReceiptId, "external_receipt_native");
  assert.equal(executions, 1);
});

test("memory conflict detection preserves competing evidence and marks review quality", () => {
  const records = [
    { id: "m1", ownerId: 1, category: "business" as const, key: "pricing", value: "$10", source: "crm", confidence: 0.7, sensitivity: "normal" as const, createdAt: 1, updatedAt: 10, status: "active" as const },
    { id: "m2", ownerId: 1, category: "business" as const, key: "pricing", value: "$20", source: "owner", confidence: 0.95, sensitivity: "normal" as const, createdAt: 2, updatedAt: 20, status: "active" as const },
  ];
  const conflicts = detectMemoryConflicts(records, 100);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.recommendedId, "m2");
  assert.equal(memoryEvidenceQuality(records[1]!, 100), "strong");
});

test("provider outcome engine only executes read-only checks and persists proof", async () => {
  await initStore({ memoryOnly: true });
  const result = await executeOutcomeVerification({ ownerId: 21, missionId: "mis_engine", checks: [{ id: "read", kind: "provider_read", description: "record is qualified", toolSlug: "CRM_GET_RECORD", expected: { status: "qualified" } }, { id: "write", kind: "provider_read", description: "must never execute", toolSlug: "CRM_UPDATE_RECORD", expected: { status: "qualified" } }], adapter: { read: async ({ toolSlug }) => { assert.equal(toolSlug, "CRM_GET_RECORD"); return { observed: { status: "qualified" }, evidenceRef: "crm:1", observedAt: Date.now() }; } } });
  assert.equal(result.status, "uncertain");
  assert.ok(result.unresolved.some((item) => item.includes("read-only")));
});

test("Composio outcome reads execute only exact available read tools and bound their inputs", async () => {
  const executed: string[] = [];
  const adapter = createComposioOutcomeReadAdapter({
    availableToolSlugs: ["GMAIL_GET_MESSAGE", "GMAIL_SEND_EMAIL"],
    now: () => 1234,
    execute: async (slug, args) => { executed.push(`${slug}:${String(args.message_id)}`); return { data: { status: "sent", nested: [{ password: "private", label: "ok" }] } }; },
  });
  const observed = await adapter.read({ toolSlug: "GMAIL_GET_MESSAGE", check: { id: "mail", kind: "provider_read", description: "Message was sent", arguments: { message_id: "m1" }, expected: { status: "sent" } } });
  assert.deepEqual(executed, ["GMAIL_GET_MESSAGE:m1"]);
  assert.equal(observed.provider, "gmail");
  assert.equal(observed.observedAt, 1234);
  await assert.rejects(() => adapter.read({ toolSlug: "GMAIL_SEND_EMAIL", check: { id: "write", kind: "provider_read", description: "write", arguments: {} } }), /read-only/);
  const restricted = createComposioOutcomeReadAdapter({ availableToolSlugs: ["CRM_GET_LEAD"], allowedToolSlugs: ["GMAIL_GET_MESSAGE"], execute: async () => ({}) });
  await assert.rejects(() => restricted.read({ toolSlug: "CRM_GET_LEAD", check: { id: "policy", kind: "provider_read", description: "not granted", arguments: {} } }), /active tool policy/);
  const mixedAction = createComposioOutcomeReadAdapter({ availableToolSlugs: ["GMAIL_GET_AND_SEND_EMAIL"], execute: async () => { throw new Error("mixed read/write action must not execute"); } });
  await assert.rejects(() => mixedAction.read({ toolSlug: "GMAIL_GET_AND_SEND_EMAIL", check: { id: "mixed", kind: "provider_read", description: "must fail closed", arguments: {} } }), /read-only/);
  await assert.rejects(() => adapter.read({ toolSlug: "GMAIL_GET_MESSAGE", check: { id: "secret", kind: "provider_read", description: "read", arguments: { password: "never" } } }), /not allowed/);
  assert.equal(executed.length, 1);
});

test("native strict mission closes with an exact trusted receipt and completed steps", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 9823;
  const mission = await createMission(ownerId, { title: "Receipt closeout", objective: "Verify existing work", definitionOfDone: "Trusted receipt and completed step", verificationMode: "strict", requiredEvidence: ["kind:tool_receipt", "kind:before_after"], steps: [{ id: "work", title: "Work", objective: "Record provider execution" }] });
  await startMission(ownerId, mission.id);
  await recordTrustedMissionEvidence(ownerId, mission.id, [{ id: "real_receipt", kind: "tool_receipt", summary: "Provider executed", source: "provider", ref: "log_real", verified: true }]);
  await completeMissionStep(ownerId, mission.id, "work", "Work done");
  const result = await nativeTool(ownerId, "CHUCK_MISSION_VERIFY", { id: mission.id, evidenceIds: ["real_receipt"], checks: [
    { id: "execution", kind: "receipt", description: "Recorded execution exists", evidenceId: "real_receipt" },
    { id: "state", kind: "provider_read", description: "Sheet matches", toolSlug: "GOOGLESHEETS_VALUES_GET", expected: { values: [["Item", "Status"], ["Test A", "Ready"], ["Test B", "Ready"]] } },
  ] }, { outcomeReadAdapter: { read: async () => ({ observed: { values: [["Item", "Status"], ["Test A", "Ready"], ["Test B", "Ready"]] }, provider: "sheets", evidenceRef: "read_real", observedAt: Date.now() }) } });
  assert.equal((result as { status: string }).status, "completed");
  assert.equal((await getMission(ownerId, mission.id))?.verification?.verified, true);
});

test("strict native-only missions derive trusted evidence from persisted lifecycle facts", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 9824;
  const mission = await createMission(ownerId, {
    title: "Native lifecycle proof",
    objective: "Prove a durable native-only mission lifecycle.",
    definitionOfDone: "Three steps, a real durable timer wait, and persisted internal proof are complete.",
    verificationMode: "strict",
    requiredEvidence: [
      "mission ID and step count",
      "pre-wait durable checkpoint",
      "60-second durable timer wait",
      "post-wait durable checkpoint",
      "all three steps completed",
    ],
    steps: [
      { id: "step-1", title: "Baseline", objective: "Persist the baseline." },
      { id: "step-2", title: "Wait", objective: "Wait durably.", dependsOn: ["step-1"] },
      { id: "step-3", title: "Close", objective: "Close with internal proof.", dependsOn: ["step-2"] },
    ],
  });
  await startMission(ownerId, mission.id);
  await checkpointMission(ownerId, mission.id, "baseline checkpoint", "Enter the durable timer wait.");
  await completeMissionStep(ownerId, mission.id, "step-1", "Baseline persisted.");

  const runAt = Date.now() - 60_000;
  await waitMission(ownerId, mission.id, { kind: "timer", runAt, stepId: "step-2" }, "pre-wait checkpoint", "Resume after the durable timer.");
  assert.ok(await resumeMissionFromTimer(ownerId, mission.id, runAt));
  await checkpointMission(ownerId, mission.id, "post-wait checkpoint", "Complete the remaining native steps.");
  await completeMissionStep(ownerId, mission.id, "step-2", "Durable wait completed.");
  await completeMissionStep(ownerId, mission.id, "step-3", "Internal proof is complete.");

  const verified = await verifyMission(ownerId, mission.id);
  assert.equal(verified?.verification?.verified, true, verified?.verification?.unresolved?.join("; "));
  assert.ok(verified?.evidence?.some((item) => item.verifiedBy === "system" && item.summary.includes("60-second durable timer wait")));
  assert.ok(verified?.evidence?.some((item) => item.verifiedBy === "system" && item.summary.toLowerCase().includes("all three steps completed")));

  const completed = await finalizeMissionIfReady(ownerId, mission.id);
  assert.equal(completed?.status, "completed");
});

test("Composio outcome reads preserve bounded provider failure details", async () => {
  const adapter = createComposioOutcomeReadAdapter({
    availableToolSlugs: ["GOOGLESHEETS_VALUES_GET"],
    execute: async () => ({ successful: false, error: { message: "range is invalid" } }),
  });
  await assert.rejects(
    () => adapter.read({ toolSlug: "GOOGLESHEETS_VALUES_GET", check: { id: "sheet", kind: "provider_read", description: "Sheet is correct", arguments: { range: "Sheet1!A1:D20" }, expected: { rows: 3 } } }),
    /range is invalid/,
  );
});

test("verification resolves read actions behind meta-tools while enforcing grants before discovery", async () => {
  const calls: string[] = [];
  const input = {
    availableToolSlugs: ["COMPOSIO_MULTI_EXECUTE_TOOL"],
    resolve: async (slug: string) => { calls.push(`resolve:${slug}`); return slug === "GOOGLESHEETS_VALUES_GET"; },
    execute: async (slug: string) => { calls.push(`execute:${slug}`); return { successful: true, data: { values: [["Item", "Status"], ["Test A", "Ready"], ["Test B", "Ready"]] } }; },
  };
  const check = { id: "sheet", kind: "provider_read" as const, description: "Exact rows", arguments: { range: "Sheet1!A1:D20" }, expected: { values: [["Item", "Status"], ["Test A", "Ready"], ["Test B", "Ready"]] } };
  const observed = await createComposioOutcomeReadAdapter(input).read({ toolSlug: "GOOGLESHEETS_VALUES_GET", check });
  assert.deepEqual(observed.observed?.values, check.expected.values);
  assert.deepEqual(calls, ["resolve:GOOGLESHEETS_VALUES_GET", "execute:GOOGLESHEETS_VALUES_GET"]);
  calls.length = 0;
  await assert.rejects(() => createComposioOutcomeReadAdapter({ ...input, deniedToolSlugs: ["GOOGLESHEETS_VALUES_GET"] }).read({ toolSlug: "GOOGLESHEETS_VALUES_GET", check }), /active tool policy/);
  await assert.rejects(() => createComposioOutcomeReadAdapter(input).read({ toolSlug: "GOOGLESHEETS_UPDATE_VALUES", check }), /read-only/);
  assert.deepEqual(calls, []);
});

test("outcome engine ignores model-supplied provider pass results without a provider read", async () => {
  await initStore({ memoryOnly: true });
  const result = await executeOutcomeVerification({
    ownerId: 210,
    checks: [{ id: "crm", kind: "provider_read", description: "Lead is qualified", toolSlug: "CRM_GET_LEAD", freshnessMs: 60_000, expected: { status: "qualified" } }],
    suppliedResults: [{ checkId: "crm", status: "passed", observed: { status: "qualified" }, provider: "crm", evidenceRef: "fake", observedAt: Date.now() }],
  });
  assert.equal(result.status, "uncertain");
  assert.match(result.unresolved[0]!, /No provider read adapter/);
});

test("provider reads without explicit expected state cannot certify a mission outcome", async () => {
  let reads = 0;
  const result = await executeOutcomeVerification({
    ownerId: 212,
    missionId: "mis_unbounded_read",
    checks: [{ id: "any_read", kind: "provider_read", description: "Lead source URLs are verified", toolSlug: "CRM_GET_LEAD" }],
    adapter: { read: async () => { reads += 1; return { observed: { status: "qualified" }, provider: "crm", evidenceRef: "real-read", observedAt: Date.now() }; } },
  });
  assert.equal(reads, 0);
  assert.equal(result.status, "uncertain");
  assert.match(result.unresolved.join(" "), /no expected state fields/i);
});

test("persisted outcome observations redact sensitive fields recursively and omit read arguments", () => {
  const result = verifyOutcome({ ownerId: 211, checks: [{ id: "read", kind: "provider_read", description: "Read", toolSlug: "GMAIL_GET_MESSAGE", arguments: { message_id: "private-id" } }], results: [{ checkId: "read", status: "passed", provider: "gmail", evidenceRef: "proof", observedAt: 100, observed: { nested: [{ password: "hidden", label: "visible" }] } }], now: 100 });
  assert.equal("arguments" in result.checks[0]!, false);
  assert.deepEqual(result.results[0]?.observed, { nested: [{ label: "visible" }] });
});

test("mission replay and operator timeline are deterministic", () => {
  const mission = { id: "mis_replay", userId: 1, title: "x", objective: "x", definitionOfDone: "x", status: "completed" as const, result: "done", steps: [], budget: { maxDurationSeconds: 1, maxSteps: 1, maxToolCalls: 1, maxCost: 1 }, consumedSteps: 0, toolCalls: 0, cost: 0, createdAt: 1, updatedAt: 4, events: [{ id: "e1", type: "started" as const, message: "started", at: 1 }, { id: "e2", type: "checkpointed" as const, message: "checkpoint", at: 2 }, { id: "e3", type: "completed" as const, message: "done", at: 3 }], version: 1 };
  assert.equal(replayMission(mission).status, "passed");
  const timeline = buildOperatorTimeline({ mission, trace: [], approvals: [] });
  assert.equal(timeline.at(-1)?.type, "mission.completed");
});

test("persisted mission replay pairs exact approval lifecycle IDs and rejects incomplete history", () => {
  const mission = { id: "mis_approval_replay", userId: 1, title: "x", objective: "x", definitionOfDone: "x", status: "completed" as const, result: "done", steps: [], budget: { maxDurationSeconds: 1, maxSteps: 1, maxToolCalls: 1, maxCost: 1 }, consumedSteps: 0, toolCalls: 0, cost: 0, createdAt: 1, updatedAt: 7, events: [
    { id: "e1", type: "started" as const, message: "started", at: 1 },
    { id: "e2", type: "checkpointed" as const, message: "before approval", at: 2 },
    { id: "e3", type: "approval_waiting" as const, message: "Approve action", at: 3, metadata: { approvalId: "appr_exact" } },
    { id: "e4", type: "approval_resumed" as const, message: "Approved", at: 4, metadata: { approvalId: "appr_exact" } },
    { id: "e5", type: "checkpointed" as const, message: "after approval", at: 5 },
    { id: "e6", type: "completed" as const, message: "done", at: 6 },
  ], version: 1 };
  assert.equal(replayMission(mission).status, "passed");

  const pending = { ...mission, events: mission.events.filter((event) => event.id !== "e4") };
  assert.ok(replayMission(pending).violations.includes("pending_approval_at_terminal_state"));

  const mismatched = { ...mission, events: mission.events.map((event) => event.id === "e4" ? { ...event, metadata: { approvalId: "appr_other" } } : event) };
  assert.ok(replayMission(mismatched).violations.includes("approval_resumed_without_matching_wait"));

  const missingId = { ...mission, events: mission.events.map((event) => event.id === "e3" ? { ...event, metadata: undefined } : event) };
  assert.ok(replayMission(missingId).violations.includes("approval_waiting_without_id"));

  const legacy = { ...mission, events: [
    { id: "l1", type: "started" as const, message: "started", at: 1 },
    { id: "l2", type: "checkpointed" as const, message: "checkpoint", at: 2 },
    { id: "l3", type: "waiting" as const, message: "Approve or deny TOOL (appr_legacy) before the mission can continue.", at: 3 },
    { id: "l4", type: "resumed" as const, message: "Approval appr_legacy granted; mission resumed from its checkpoint.", at: 4 },
    { id: "l5", type: "completed" as const, message: "done", at: 5 },
  ] };
  assert.ok(replayMission(legacy).violations.includes("legacy_approval_wait_missing_structured_lifecycle"));
});

test("approval escalation claims once and fails closed without a provider adapter", async () => {
  await initStore({ memoryOnly: true });
  const record = await scheduleApprovalEscalation({ ownerId: 22, approvalId: "appr_1", summary: "Review", dueAt: 1 });
  const result = await runDueApprovalEscalations(22, undefined, 2);
  assert.equal(result[0]?.id, record.id);
  assert.equal(result[0]?.status, "failed");
  assert.equal((await runDueApprovalEscalations(22, undefined, 3)).length, 0);
});

test("approval escalation persists an exact safe action and executes through an adapter", async () => {
  await initStore({ memoryOnly: true });
  const record = await scheduleApprovalEscalation({ ownerId: 23, approvalId: "appr_2", destination: "jira", summary: "Review", dueAt: 1, toolSlug: "JIRA_CREATE_ISSUE", toolArgs: { project: "OPS", token: "must-not-persist", summary: "Review" } });
  assert.equal(record.toolSlug, "JIRA_CREATE_ISSUE");
  assert.deepEqual(record.toolArgs, { project: "OPS", summary: "Review" });
  const result = await runDueApprovalEscalations(23, { create: async (input) => ({ externalIssueKey: `${input.toolSlug}-123`, summary: "Created" }) }, 2);
  assert.equal(result[0]?.status, "escalated");
  assert.equal(result[0]?.externalIssueKey, "JIRA_CREATE_ISSUE-123");
});

test("meeting follow-through and opportunity detection fail closed on missing receipts", () => {
  assert.equal(verifyMeetingFollowThrough([{ id: "f1", required: true, status: "scheduled", dueAt: 1 }], 2).status, "pending");
  assert.equal(verifyMeetingFollowThrough([{ id: "f1", required: true, status: "ambiguous" }]).status, "blocked");
  assert.equal(detectBusinessOpportunities([{ source: "crm", kind: "lead", id: "l1", status: "qualified", subject: "A" }]).length, 1);
});

test("provider certification requires fresh proof for every modality", async () => {
  const x = providerMatrix({ X_CONSUMER_SECRET: "secret", X_USER_ACCESS_TOKEN: "token" }).find((entry) => entry.surface === "x");
  assert.equal(x?.inboundImage, false);
  assert.equal(x?.outboundImage, true);
  assert.match(x?.missing ?? "", /Inbound DM images are not exposed/);

  const capabilities: ProviderSmokeCapability[] = ["inbound_text", "inbound_image", "outbound_text", "outbound_image"];
  const proofs = await runProviderSmokeSuite([{ surface: "web", run: async () => [
    ...capabilities.map((capability) => ({ capability, status: "passed" as const, observedAt: 9_000, evidenceHash: createHash("sha256").update(capability).digest("hex") })),
  ] }], 10_000, 60_000);
  assert.equal(proofs.length, 1);
  assert.equal(providerMatrixWithProofs({}, proofs, 10_001).find((entry) => entry.surface === "web")?.liveProof, "verified");
  assert.equal(providerMatrixWithProofs({}, proofs, 70_001).find((entry) => entry.surface === "web")?.liveProof, "configured_unverified");

  const missingCapability = await runProviderSmokeSuite([{ surface: "web", run: async () => capabilities.slice(0, 3).map((capability) => ({ capability, status: "passed" as const, observedAt: 9_000, evidenceHash: createHash("sha256").update(capability).digest("hex") })) }], 10_000);
  assert.equal(missingCapability.length, 0);
  const repeatedEvidence = await runProviderSmokeSuite([{ surface: "web", run: async () => capabilities.map((capability) => ({ capability, status: "passed" as const, observedAt: 9_000, evidenceHash: "a".repeat(64) })) }], 10_000);
  assert.equal(repeatedEvidence.length, 0);

  const legacyProof = { ...proofs[0]!, checks: [{ name: "one generic check", status: "passed" }] } as unknown as ProviderProof;
  assert.equal(providerMatrixWithProofs({}, [legacyProof], 10_001).find((entry) => entry.surface === "web")?.liveProof, "configured_unverified");
});

test("readiness blocks ephemeral persistence and reports unverified providers", () => {
  const report = buildReadinessReport({ durableStore: false, qstashConfigured: false, providerMatrix: providerMatrixWithProofs({}), proofs: [], now: 1 });
  assert.equal(report.status, "blocked");
  assert.ok(report.blocking.includes("durable_store"));
  assert.ok(report.warnings.includes("provider_proofs"));
});

test("execution quota admission is atomic across concurrent durable workers", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 991300;
  const [left, right] = await Promise.all([
    reserveExecutionQuota(ownerId, "sdk.run", { maxConcurrent: 1 }, "quota_left", 1_000),
    reserveExecutionQuota(ownerId, "sdk.run", { maxConcurrent: 1 }, "quota_right", 1_000),
  ]);
  assert.equal([left, right].filter((item) => item.allowed).length, 1);
  const winner = left.allowed ? left : right;
  await releaseExecutionQuota(ownerId, winner.reservationId!);
  const after = await reserveExecutionQuota(ownerId, "sdk.run", { maxConcurrent: 1 }, "quota_after", 2_000);
  assert.equal(after.allowed, true);
  const otherOperation = await reserveExecutionQuota(ownerId, "other.run", { maxConcurrent: 1 }, "quota_other", 2_000);
  assert.equal(otherOperation.allowed, true);
  const replay = await reserveExecutionQuota(ownerId, "other.run", { maxConcurrent: 1 }, "quota_other", 2_000);
  assert.equal(replay.allowed, true);
  await releaseExecutionQuota(ownerId, "quota_after");
  await releaseExecutionQuota(ownerId, "quota_other");
  const dailyOwner = 991301;
  const dailyFirst = await reserveExecutionQuota(dailyOwner, "sdk.run", { maxCallsPerDay: 1, maxConcurrent: 10 }, "quota_daily_first", 1_000);
  const dailySecond = await reserveExecutionQuota(dailyOwner, "sdk.run", { maxCallsPerDay: 1, maxConcurrent: 10 }, "quota_daily_second", 1_000);
  assert.equal(dailyFirst.allowed, true);
  assert.equal(dailySecond.allowed, false);
  await releaseExecutionQuota(dailyOwner, "quota_daily_first");
});
