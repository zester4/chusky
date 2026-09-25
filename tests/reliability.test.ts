import assert from "node:assert/strict";
import test from "node:test";
import { assessReliability, makeQuotaDecision, verifyOutcome } from "../src/reliability/evaluator.js";
import { replayMission, replayScenario } from "../src/reliability/replay.js";
import { compileAutonomyPolicy } from "../src/reliability/policy.js";
import { executeCompensation, listCompensations, queueCompensation } from "../src/reliability/persistence.js";
import { initStore } from "../src/store.js";
import { detectMemoryConflicts, memoryEvidenceQuality } from "../src/memory/conflicts.js";
import { executeOutcomeVerification } from "../src/reliability/outcomeEngine.js";
import { buildOperatorTimeline } from "../src/reliability/timeline.js";
import { runDueApprovalEscalations, scheduleApprovalEscalation } from "../src/approvals/escalation.js";
import { verifyMeetingFollowThrough } from "../src/meetings/followThroughVerification.js";
import { detectBusinessOpportunities } from "../src/autonomy/opportunityDetectors.js";

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

test("compensation records are durable, approval-gated, and idempotent", async () => {
  await initStore({ memoryOnly: true });
  const first = await queueCompensation({ ownerId: 12, originalActionId: "act_1", provider: "composio", objective: "Undo the duplicate CRM update" });
  const same = await queueCompensation({ ownerId: 12, originalActionId: "act_1", provider: "composio", objective: "Undo the duplicate CRM update" });
  assert.equal(same.id, first.id);
  const blocked = await executeCompensation({ ownerId: 12, id: first.id, approved: false, execute: async () => ({ summary: "must not run" }) });
  assert.equal(blocked?.status, "blocked");
  const done = await executeCompensation({ ownerId: 12, id: first.id, approved: true, execute: async () => ({ summary: "provider receipt" }) });
  assert.equal(done?.status, "succeeded");
  assert.equal((await listCompensations(12)).length, 1);
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

test("mission replay and operator timeline are deterministic", () => {
  const mission = { id: "mis_replay", userId: 1, title: "x", objective: "x", definitionOfDone: "x", status: "completed" as const, steps: [], budget: { maxDurationSeconds: 1, maxSteps: 1, maxToolCalls: 1, maxCost: 1 }, consumedSteps: 0, toolCalls: 0, cost: 0, createdAt: 1, updatedAt: 4, events: [{ id: "e1", type: "started" as const, message: "started", at: 1 }, { id: "e2", type: "checkpointed" as const, message: "checkpoint", at: 2 }, { id: "e3", type: "completed" as const, message: "done", at: 3 }], version: 1 };
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
