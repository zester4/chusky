import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { findMissionApprovalTarget, resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import { claimApproval, createApproval, createMission, createTask, getMission, getTask, initStore, startMission, updateTask, waitMission } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

async function waitingMission(userId: number, taskStatus: "queued" | "blocked" = "queued") {
  const approval = await createApproval({
    userId,
    toolSlug: "GITHUB_DELETE_REPOSITORY",
    args: { repository: "example/repo" },
    request: "Delete the test repository.",
    history: [],
    model: "test/model",
  });
  assert.ok(await claimApproval(userId, approval.id));
  const mission = await createMission(userId, {
    id: `mis_approval_${userId}`,
    title: "Approval resume fixture",
    objective: "Continue the mission after its exact action is approved.",
    definitionOfDone: "The original task resumes from its checkpoint.",
    steps: [{ id: "step-1", title: "Continue work", objective: "Continue safely." }],
  });
  await startMission(userId, mission.id);
  const task = await createTask(userId, {
    id: `task_approval_${userId}`,
    title: "Original mission slice",
    objective: "Resume from the stored checkpoint.",
    missionId: mission.id,
    missionStepId: "step-1",
  });
  if (taskStatus === "blocked") await updateTask(userId, task.id, { status: "blocked" });
  await waitMission(userId, mission.id, { kind: "approval", key: approval.id, stepId: "step-1" }, "Verified checkpoint", "Approve the pending action.");
  return { mission, task, approvalId: approval.id };
}

test("approved mission resumes its queued delayed task immediately", async () => {
  const userId = 995101;
  const { mission, task, approvalId } = await waitingMission(userId);
  await updateTask(userId, task.id, { runAt: Date.now() + 60_000, workflowRunId: "wf-delayed" });
  let published: { userId: number; taskId: string; runAt: number } | undefined;

  const result = await resumeMissionTaskAfterApproval(userId, approvalId, async (owner, taskId, runAt) => {
    published = { userId: owner, taskId, runAt };
    return "wf-immediate";
  });

  assert.equal(result.status, "resumed");
  assert.equal(published?.userId, userId);
  assert.equal(published?.taskId, task.id);
  assert.ok((published?.runAt ?? Infinity) <= Date.now());
  assert.equal((await getMission(userId, mission.id))?.status, "running");
  const resumedTask = await getTask(userId, task.id);
  assert.equal(resumedTask?.status, "queued");
  assert.equal(resumedTask?.approvedApprovalId, approvalId);
  assert.equal(resumedTask?.workflowRunId, "wf-immediate");
});

test("approved mission can retry its blocked original task", async () => {
  const userId = 995102;
  const { task, approvalId } = await waitingMission(userId, "blocked");

  const result = await resumeMissionTaskAfterApproval(userId, approvalId, async () => "wf-retry");

  assert.equal(result.status, "resumed");
  const resumedTask = await getTask(userId, task.id);
  assert.equal(resumedTask?.status, "queued");
  assert.equal(resumedTask?.approvedApprovalId, approvalId);
  assert.equal(resumedTask?.workflowRunId, "wf-retry");
});

test("approval resume requires the exact waiting approval and owner", async () => {
  const userId = 995103;
  const { mission, approvalId } = await waitingMission(userId);

  assert.equal(await findMissionApprovalTarget(userId, "appr_other"), undefined);
  assert.equal((await resumeMissionTaskAfterApproval(userId, "appr_other")).status, "not_mission");
  assert.equal(await findMissionApprovalTarget(userId + 1, approvalId), undefined);
  assert.equal((await resumeMissionTaskAfterApproval(userId + 1, approvalId)).status, "not_mission");
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
});
