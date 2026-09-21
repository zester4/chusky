import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { claimTask, createTask, initStore, createMission, getMission, listTasks, retryTask, settleTaskRun, startMission, completeMission, completeMissionStep, recordMissionEvidence, recordTrustedMissionEvidence, updateTask, verifyMission, missionBudgetPreflight } from "../src/store.js";
import { contextPrompt, selectContext, upsertContextNode } from "../src/contextGraph.js";
import { createDepartmentHandoff, provisionDepartment } from "../src/departments.js";
import { getOutcomePackage, planOutcome } from "../src/outcomes/catalog.js";
import { scheduleMissionSteps } from "../src/missionScheduler.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("context graph selects purpose-scoped, non-expired, non-sensitive context", async () => {
  const userId = 972001;
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "decision", key: "ICP", value: "Fintech companies with 50+ employees", sensitivity: "normal", confidence: 0.9 });
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "fact", key: "secret", value: "do not expose", sensitivity: "sensitive" });
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "fact", key: "expired", value: "old", sensitivity: "normal", expiresAt: Date.now() - 1 });
  const nodes = await selectContext(userId, { scope: "department", scopeId: "sales", purpose: "sales" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, "ICP");
  assert.match(await contextPrompt(userId, { purpose: "sales" }), /50\+ employees/);
});

test("department spaces and typed handoffs persist by owner", async () => {
  const userId = 972002;
  const department = await provisionDepartment(userId, "marketing", { approvedTools: ["COMPOSIO_SEARCH_WEB"] });
  const packet = await createDepartmentHandoff(userId, { department: "marketing", objective: "Prepare campaign brief", inputs: { campaign: "launch" }, constraints: ["Use approved claims"], evidenceRequired: ["source URLs"], toAgent: "maya" });
  assert.equal(department.department, "marketing");
  assert.equal(packet.status, "queued");
  assert.equal((await provisionDepartment(userId + 1, "marketing")).id === department.id, false);
});

test("outcome packages plan typed work and expose missing inputs", () => {
  const outcome = getOutcomePackage("qualified-fintech-leads");
  assert.ok(outcome);
  const plan = planOutcome("qualified-fintech-leads", { "ideal customer profile": "B2B fintech" });
  assert.ok(plan.missingInputs.includes("target geography"));
  assert.equal(plan.steps.at(-1)?.id, "verify");
  assert.match(plan.definitionOfDone, /Every lead/);
});

test("mission supports parallel ready steps, preflight budgets, and evidence verification", async () => {
  const userId = 972003;
  const mission = await createMission(userId, { title: "Launch", objective: "Prepare launch", definitionOfDone: "Two tracks are verified", requiredEvidence: ["source"], steps: [
    { id: "research", title: "Research", objective: "Research", parallelGroup: "prep" },
    { id: "design", title: "Design", objective: "Design", parallelGroup: "prep" },
    { id: "review", title: "Review", objective: "Review", dependsOn: ["research", "design"] },
  ] });
  const started = await startMission(userId, mission.id);
  assert.deepEqual(started?.activeStepIds?.sort(), ["design", "research"]);
  assert.equal(missionBudgetPreflight(started!, { toolCalls: 1 }).allowed, true);
  const first = await completeMissionStep(userId, mission.id, "research", "Research done");
  assert.equal(first?.steps.find((step) => step.id === "review")?.status, "pending");
  const second = await completeMissionStep(userId, mission.id, "design", "Design done");
  assert.equal(second?.steps.find((step) => step.id === "review")?.status, "running");
  await recordTrustedMissionEvidence(userId, mission.id, [{ id: "source-1", kind: "source", summary: "source verified", ref: "https://example.test/source", verified: true, verifiedBy: "system" }]);
  const verified = await verifyMission(userId, mission.id);
  assert.equal(verified?.verification?.verified, false); // review still has not completed
  await completeMissionStep(userId, mission.id, "review", "Review done");
  const done = await verifyMission(userId, mission.id);
  assert.equal(done?.verification?.verified, true);
  assert.equal((await getMission(userId, mission.id))?.events.some((event) => event.type === "step_completed"), true);
});

test("mission scheduler materializes each parallel branch as an idempotent durable task", async () => {
  const userId = 972004;
  const mission = await createMission(userId, { title: "Parallel work", objective: "Run independent tracks", definitionOfDone: "Both tracks complete", steps: [
    { id: "a", title: "Track A", objective: "A" },
    { id: "b", title: "Track B", objective: "B" },
  ] });
  const started = await startMission(userId, mission.id);
  const enqueued: string[] = [];
  const linked = await scheduleMissionSteps(userId, started!, async (_owner, taskId) => { enqueued.push(taskId); return `qstash_${taskId}`; });
  assert.equal(enqueued.length, 2);
  assert.equal((await listTasks(userId)).filter((task) => task.missionId === mission.id).length, 2);
  assert.equal(linked?.steps.every((step) => Boolean(step.taskId)), true);
  const again = await scheduleMissionSteps(userId, linked!, async (_owner, taskId) => { enqueued.push(taskId); return `duplicate_${taskId}`; });
  assert.equal(enqueued.length, 2);
  assert.equal(again?.rootTaskId, linked?.rootTaskId);
});

test("strict missions cannot be completed before independent verification", async () => {
  const userId = 972005;
  const mission = await createMission(userId, { title: "Verified outcome", objective: "Produce proof", definitionOfDone: "Evidence is verified", requiredEvidence: ["receipt"] });
  const started = await startMission(userId, mission.id);
  assert.equal(await completeMission(userId, mission.id, "premature"), undefined);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Step result");
  await recordMissionEvidence(userId, mission.id, [{ id: "assertion-1", kind: "assertion", summary: "receipt confirmed", verified: true, verifiedBy: "agent" }]);
  const rejected = await verifyMission(userId, mission.id);
  assert.equal(rejected?.verification?.verified, false);
  await recordTrustedMissionEvidence(userId, mission.id, [{ id: "receipt-1", kind: "tool_receipt", summary: "receipt confirmed", ref: "tool://receipt-1", verified: true, verifiedBy: "system" }]);
  await verifyMission(userId, mission.id);
  const completed = await completeMission(userId, mission.id, "Outcome verified");
  assert.equal(completed?.status, "completed");
});

test("terminal task failure reconciles the linked mission step and mission status", async () => {
  const userId = 972006;
  const mission = await createMission(userId, { title: "Failure recovery", objective: "Run one bounded step", definitionOfDone: "The step succeeds", steps: [{ id: "only", title: "Only step", objective: "Run once", retryLimit: 0 }] });
  const started = await startMission(userId, mission.id);
  await scheduleMissionSteps(userId, started!, async () => "workflow_failure");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  const claimed = await claimTask(userId, task!.id, "failure-worker", 60_000);
  assert.ok(claimed?.lease);
  await settleTaskRun(userId, task!.id, claimed!.lease!.token, { status: "failed", message: "Provider permanently rejected the request" });
  const failed = await getMission(userId, mission.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.steps.find((step) => step.id === "only")?.status, "failed");
  assert.match(failed?.nextAction ?? "", /repair|replan/i);
});

test("concurrent mission schedulers publish one workflow for one deterministic step", async () => {
  const userId = 972007;
  const mission = await createMission(userId, { title: "Concurrent schedule", objective: "Run once", definitionOfDone: "One step", steps: [{ id: "only", title: "Only", objective: "Run" }] });
  const started = await startMission(userId, mission.id);
  let enqueues = 0;
  await Promise.all([
    scheduleMissionSteps(userId, started!, async () => { enqueues += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return `workflow_${enqueues}`; }),
    scheduleMissionSteps(userId, started!, async () => { enqueues += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return `workflow_${enqueues}`; }),
  ]);
  assert.equal(enqueues, 1);
});

test("mission scheduler recovers an expired pending enqueue claim", async () => {
  const userId = 972008;
  const mission = await createMission(userId, { title: "Recover publish", objective: "Recover", definitionOfDone: "One step", steps: [{ id: "only", title: "Only", objective: "Run" }] });
  const started = await startMission(userId, mission.id);
  const first = await scheduleMissionSteps(userId, started!, async () => "workflow_first");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  await updateTask(userId, task!.id, { workflowRunId: "pending:crashed-publisher", enqueueClaim: { token: "crashed-publisher", expiresAt: Date.now() - 1 } });
  let publishes = 0;
  await scheduleMissionSteps(userId, first!, async () => { publishes += 1; return "workflow_recovered"; });
  assert.equal(publishes, 1);
  assert.equal((await listTasks(userId)).find((item) => item.id === task!.id)?.workflowRunId, "workflow_recovered");
});

test("manual task retry clears stale provider publication state", async () => {
  const userId = 972009;
  const task = await createTask(userId, { title: "Retry me", objective: "Retry", runAt: Date.now() });
  await updateTask(userId, task.id, { status: "failed", workflowRunId: "workflow_old", enqueueClaim: { token: "old", expiresAt: Date.now() + 60_000 } });
  const retried = await retryTask(userId, task.id);
  assert.equal(retried?.status, "queued");
  assert.equal(retried?.workflowRunId, undefined);
  assert.equal(retried?.enqueueClaim, undefined);
});
