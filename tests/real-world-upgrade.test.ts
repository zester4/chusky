import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initStore, createMission, getMission, listTasks, startMission, completeMission, completeMissionStep, recordMissionEvidence, verifyMission, missionBudgetPreflight } from "../src/store.js";
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
  await recordMissionEvidence(userId, mission.id, [{ id: "source-1", kind: "source", summary: "source verified", verified: true, verifiedBy: "system" }]);
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
  await recordMissionEvidence(userId, mission.id, [{ id: "receipt-1", kind: "tool_receipt", summary: "receipt confirmed", verified: true, verifiedBy: "system" }]);
  await verifyMission(userId, mission.id);
  const completed = await completeMission(userId, mission.id, "Outcome verified");
  assert.equal(completed?.status, "completed");
});
