import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { findMissionApprovalTarget, requestMissionDurationApproval, resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import { claimApproval, createApproval, createMission, createTask, getApproval, getMission, getTask, initStore, listApprovals, startMission, updateMission, updateTask, waitMission } from "../src/store.js";

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
  const resumedMission = await getMission(userId, mission.id);
  assert.equal(resumedMission?.status, "running");
  const approvalEvents = resumedMission?.events.filter((event) => event.type === "approval_waiting" || event.type === "approval_resumed");
  assert.deepEqual(approvalEvents?.map(({ type, metadata }) => ({ type, approvalId: metadata?.approvalId })), [
    { type: "approval_waiting", approvalId },
    { type: "approval_resumed", approvalId },
  ]);
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

test("expired mission creates one exact duration approval and pauses the same mission", async () => {
  const userId = 995104;
  const mission = await createMission(userId, {
    id: `mis_duration_${userId}`,
    title: "Duration recovery",
    objective: "Continue a mission after its bounded execution allowance expires.",
    definitionOfDone: "The saved checkpoint is resumed and verified.",
    budget: { maxDurationSeconds: 60, durationMode: "wall_clock", maxSteps: 4, maxToolCalls: 20, maxCost: 1 },
    steps: [{ id: "step-1", title: "Continue", objective: "Continue from checkpoint." }],
  });
  const started = await startMission(userId, mission.id);
  assert.ok(started);
  await updateMission(userId, mission.id, (current) => ({ startedAt: Date.now() - 120_000, error: "Mission duration budget would be exceeded." }));
  const task = await createTask(userId, { id: `task_duration_${userId}`, title: "Duration slice", objective: "Continue", missionId: mission.id, missionStepId: "step-1" });

  const first = await requestMissionDurationApproval(userId, mission.id, { taskId: task.id, model: "test/model" });
  assert.ok(first);
  assert.equal(first.mission.status, "waiting");
  assert.equal(first.approval.toolSlug, "CHUCK_MISSION_RESUME");
  assert.equal(first.approval.args.id, mission.id);
  assert.ok(Number(first.approval.args.maxDurationSeconds) >= 420 && Number(first.approval.args.maxDurationSeconds) <= 422, "wall-clock recovery extends from the original start plus five minutes");
  assert.match(first.approval.request, /exhausted its execution time/i);

  const second = await requestMissionDurationApproval(userId, mission.id, { taskId: task.id, model: "test/model" });
  assert.ok(second);
  assert.equal(second.approval.id, first.approval.id, "repeated wakes reuse the same pending approval");
  assert.equal((await listApprovals(userId)).filter((item) => item.toolSlug === "CHUCK_MISSION_RESUME").length, 1);

  assert.ok(await claimApproval(userId, first.approval.id));
  const resumed = await resumeMissionTaskAfterApproval(userId, first.approval.id, async () => "wf_duration_resume", { maxDurationSeconds: Number(first.approval.args.maxDurationSeconds) });
  assert.equal(resumed.status, "resumed");
  const resumedMission = await getMission(userId, mission.id);
  assert.equal(resumedMission?.status, "running");
  assert.equal(resumedMission?.budget.maxDurationSeconds, Number(first.approval.args.maxDurationSeconds));
  assert.equal((await getApproval(userId, first.approval.id))?.status, "approved");
  assert.equal((await getTask(userId, task.id))?.approvedApprovalId, first.approval.id);
});
