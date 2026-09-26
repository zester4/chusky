import assert from "node:assert/strict";
import test from "node:test";
import { assessReliability, makeQuotaDecision, verifyOutcome } from "../src/reliability/evaluator.js";
import { replayMission, replayScenario } from "../src/reliability/replay.js";
import { compileAutonomyPolicy } from "../src/reliability/policy.js";
import { compensationView, executeCompensation, listCompensations, queueCompensation, updateCompensation } from "../src/reliability/persistence.js";
import { nativeTool } from "../src/nativeTools.js";
import { completeMission, completeMissionStep, createMission, getMission, initStore, startMission, verifyMission, type MissionRecord } from "../src/store.js";
import { detectMemoryConflicts, memoryEvidenceQuality } from "../src/memory/conflicts.js";
import { executeOutcomeVerification } from "../src/reliability/outcomeEngine.js";
import { createComposioOutcomeReadAdapter } from "../src/reliability/composioReadAdapter.js";
import { buildOperatorTimeline } from "../src/reliability/timeline.js";
import { runDueApprovalEscalations, scheduleApprovalEscalation } from "../src/approvals/escalation.js";
import { verifyMeetingFollowThrough } from "../src/meetings/followThroughVerification.js";
import { detectBusinessOpportunities } from "../src/autonomy/opportunityDetectors.js";
import { providerMatrixWithProofs } from "../src/reliability/providerMatrix.js";
import { runProviderSmokeSuite } from "../src/reliability/providerSmoke.js";
import { buildReadinessReport } from "../src/reliability/readiness.js";
import { reserveExecutionQuota, releaseExecutionQuota } from "../src/reliability/quotas.js";

test("outcome verification rejects stale or missing provider evidence and accepts fresh matching evidence", () => {
  const now = 1_000_000;
  const verified = verifyOutcome({ ownerId: 10, missionId: "mis_1", now, checks: [{ id: "crm", kind: "provider_read", description: "Lead exists", freshnessMs: 60_000, expected: { status: "qualified" } }], results: [{ checkId: "crm", status: "passed", observed: { status: "qualified" }, observedAt: now - 10_000, evidenceRef: "crm:lead_1" }] });
  assert.equal(verified.status, "verified");
  const stale = verifyOutcome({ ownerId: 10, now, checks: [{ id: "crm", kind: "provider_read", description: "Lead exists", freshnessMs: 60_000 }], results: [{ checkId: "crm", status: "passed", observedAt: now - 61_000 }] });
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
  const result = await executeOutcomeVerification({ ownerId: 21, missionId: "mis_engine", checks: [{ id: "read", kind: "provider_read", description: "record is qualified", toolSlug: "CRM_GET_RECORD", expected: { status: "qualified" } }, { id: "write", kind: "provider_read", description: "must never execute", toolSlug: "CRM_UPDATE_RECORD" }], adapter: { read: async ({ toolSlug }) => { assert.equal(toolSlug, "CRM_GET_RECORD"); return { observed: { status: "qualified" }, evidenceRef: "crm:1", observedAt: Date.now() }; } } });
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
  const observed = await adapter.read({ toolSlug: "GMAIL_GET_MESSAGE", check: { id: "mail", kind: "provider_read", description: "Message was sent", arguments: { message_id: "m1" } } });
  assert.deepEqual(executed, ["GMAIL_GET_MESSAGE:m1"]);
  assert.equal(observed.provider, "gmail");
  assert.equal(observed.observedAt, 1234);
  await assert.rejects(() => adapter.read({ toolSlug: "GMAIL_SEND_EMAIL", check: { id: "write", kind: "provider_read", description: "write", arguments: {} } }), /read-only/);
  const restricted = createComposioOutcomeReadAdapter({ availableToolSlugs: ["CRM_GET_LEAD"], allowedToolSlugs: ["GMAIL_GET_MESSAGE"], execute: async () => ({}) });
  await assert.rejects(() => restricted.read({ toolSlug: "CRM_GET_LEAD", check: { id: "policy", kind: "provider_read", description: "not granted", arguments: {} } }), /active tool policy/);
  await assert.rejects(() => adapter.read({ toolSlug: "GMAIL_GET_MESSAGE", check: { id: "secret", kind: "provider_read", description: "read", arguments: { password: "never" } } }), /not allowed/);
  assert.equal(executed.length, 1);
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
  const proofs = await runProviderSmokeSuite([{ surface: "web", run: async () => [
    { name: "inbound text", status: "passed", inboundText: true },
    { name: "inbound image", status: "passed", inboundImage: true },
    { name: "outbound text", status: "passed", outboundText: true },
    { name: "outbound image", status: "passed", outboundImage: true },
  ] }], 10_000, 60_000);
  assert.equal(proofs.length, 1);
  assert.equal(providerMatrixWithProofs({}, proofs, 10_001).find((entry) => entry.surface === "web")?.liveProof, "verified");
  assert.equal(providerMatrixWithProofs({}, proofs, 70_001).find((entry) => entry.surface === "web")?.liveProof, "configured_unverified");
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
