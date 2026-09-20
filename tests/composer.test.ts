import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createComposerWorkflow, reconcileComposerWorkflow, startComposerWorkflow } from "../src/workflows/composer.js";
import { completeTask, getSession, initStore, setApprovalStatus } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("composer persists a dependency graph as a draft", async () => {
  const userId = 990001;
  const workflow = await createComposerWorkflow(userId, { name: "Lead qualification", stages: [
    { id: "research", title: "Research", objective: "Find candidate companies." },
    { id: "approve", title: "Approve outreach", objective: "Prepare the approved outreach list.", dependsOn: ["research"], requiresApproval: true },
  ] });
  assert.equal(workflow.status, "draft");
  assert.equal(workflow.stages[1].dependsOn[0], "research");
  assert.equal(workflow.stages[1].requiresApproval, true);
});

test("composer rejects dependency cycles", async () => {
  await assert.rejects(() => createComposerWorkflow(990002, { name: "Invalid", stages: [
    { id: "a", title: "A", objective: "A", dependsOn: ["b"] },
    { id: "b", title: "B", objective: "B", dependsOn: ["a"] },
  ] }), /dependency cycles/);
});

test("composer fans out the next stage only after dependencies complete", async () => {
  const userId = 990003;
  const workflow = await createComposerWorkflow(userId, { name: "Research then draft", stages: [
    { id: "research", title: "Research", objective: "Find candidate companies.", retryLimit: 1, budgetSeconds: 45 },
    { id: "draft", title: "Draft", objective: "Prepare a concise outreach draft.", dependsOn: ["research"] },
  ] });
  const started = await startComposerWorkflow(userId, workflow.id);
  assert.equal(started.tasks.length, 1);
  await completeTask(userId, started.tasks[0].id, "Three candidates found.");
  const enqueued: string[] = [];
  const updated = await reconcileComposerWorkflow(userId, workflow.id, async (_userId, taskId) => { enqueued.push(taskId); return `wf-run-${taskId}`; });
  assert.equal(updated?.stages.find((stage) => stage.id === "research")?.status, "completed");
  const child = updated?.stages.find((stage) => stage.id === "draft");
  assert.ok(child?.taskId);
  assert.deepEqual(enqueued, [child.taskId]);
  const stored = (await getSession(userId)).workflowComposers?.[0].stages.find((stage) => stage.id === "draft");
  assert.equal(stored?.taskId, child?.taskId);
});

test("composer approval gates a stage before task creation", async () => {
  const userId = 990004;
  const workflow = await createComposerWorkflow(userId, { name: "Approved launch", stages: [
    { id: "launch", title: "Launch", objective: "Publish the approved announcement.", requiresApproval: true },
  ] });
  const started = await startComposerWorkflow(userId, workflow.id);
  assert.equal(started.tasks.length, 0);
  const blocked = (await getSession(userId)).workflowComposers?.[0].stages[0];
  assert.equal(blocked?.status, "blocked");
  assert.ok(blocked?.approvalId);
  await setApprovalStatus(userId, blocked!.approvalId!, "approved");
  const updated = await reconcileComposerWorkflow(userId, workflow.id, async () => "approval-stage-run");
  assert.ok(updated?.stages[0].taskId);
  assert.equal(updated?.stages[0].status, "pending");
});
