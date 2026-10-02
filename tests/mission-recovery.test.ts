import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  claimTask,
  createMission,
  getMission,
  getTask,
  initStore,
  listTasks,
  startMission,
  settleTaskRun,
  updateTask,
  waitMission,
} from "../src/store.js";
import { reconcileMissionExecution } from "../src/missionScheduler.js";
import { recoverAllMissions, recoverMissionsForOwner } from "../src/missionRecovery.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

let sequence = 0;
const enqueue = async (_userId: number, taskId: string) => `workflow-recovery-${taskId}-${++sequence}`;

async function runningMission(userId: number, key: string) {
  const mission = await createMission(userId, {
    title: "Recovery proof",
    objective: "Prove recovery",
    definitionOfDone: "The durable task is scheduled.",
    idempotencyKey: key,
    steps: [{ id: "step-1", title: "Step", objective: "Do the step." }],
  });
  await startMission(userId, mission.id);
  return (await reconcileMissionExecution(userId, mission.id, enqueue))!;
}

test("sweeper republishes a queued mission task whose provider delivery was lost", async () => {
  const userId = 981001;
  const mission = await runningMission(userId, "lost-delivery");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  await updateTask(userId, task.id, { workflowRunId: undefined, enqueueClaim: undefined });
  const report = await recoverAllMissions(enqueue);
  const recovered = await getTask(userId, task.id);
  assert.equal(report.republished, 1);
  assert.match(recovered?.workflowRunId ?? "", /^workflow-recovery-/);
});

test("the default mission budget does not kill a valid 200-step plan", async () => {
  const steps = Array.from({ length: 200 }, (_, index) => ({ id: `step-${index + 1}`, title: `Step ${index + 1}`, objective: "Do one bounded unit." }));
  const mission = await createMission(981004, { title: "Long plan", objective: "Complete the plan.", definitionOfDone: "All units complete.", steps });
  assert.equal(mission.steps.length, 200);
  assert.equal(mission.budget.maxSteps, 1000);
});

test("sweeper resumes an overdue timer without creating a replacement task", async () => {
  const userId = 981002;
  const mission = await runningMission(userId, "timer");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  const waiting = await waitMission(userId, mission.id, { kind: "timer", runAt: Date.now() - 1, stepId: "step-1" }, "saved", "wake");
  assert.equal(waiting?.status, "waiting");
  const report = await recoverMissionsForOwner(userId, enqueue);
  const after = await getMission(userId, mission.id);
  assert.equal(report.timerWakes, 1);
  assert.equal(after?.status, "running");
  assert.equal((await listTasks(userId)).filter((item) => item.missionId === mission.id).length, 1);
  assert.equal((await getTask(userId, task.id))?.id, task.id);
});

test("sweeper quarantines an expired in-flight lease instead of replaying uncertain work", async () => {
  const userId = 981003;
  const mission = await runningMission(userId, "expired-lease");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  const claimed = await claimTask(userId, task.id, "recovery-proof-worker", 1_000);
  assert.ok(claimed?.lease);
  await updateTask(userId, task.id, { lease: { ...claimed!.lease!, expiresAt: Date.now() - 1 } });
  const report = await recoverMissionsForOwner(userId, enqueue);
  const afterTask = await getTask(userId, task.id);
  const afterMission = await getMission(userId, mission.id);
  assert.equal(report.quarantined, 1);
  assert.equal(afterTask?.status, "blocked");
  assert.equal(afterTask?.lease, undefined);
  assert.equal(afterMission?.status, "blocked");
  assert.match(afterMission?.nextAction ?? "", /receipt|read-back/i);
});

test("sweeper does not invent a provider receipt for an expired native-only step", async () => {
  const userId = 981007;
  const mission = await createMission(userId, {
    title: "Native recovery proof",
    objective: "Persist an internal checkpoint.",
    definitionOfDone: "The internal checkpoint is present.",
    idempotencyKey: "native-expired-lease",
    steps: [{ id: "step-1", title: "Record facts", objective: "Record internal facts." }],
  });
  await startMission(userId, mission.id);
  await reconcileMissionExecution(userId, mission.id, enqueue);
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  await updateTask(userId, task.id, { missionAllowedTools: ["CHUCK_MISSION_CHECKPOINT"] });
  const nativeOnlyTask = (await getTask(userId, task.id))!;
  assert.deepEqual(nativeOnlyTask.missionAllowedTools, ["CHUCK_MISSION_CHECKPOINT"]);
  const claimed = await claimTask(userId, task.id, "native-recovery-worker", 1_000);
  assert.ok(claimed?.lease);
  await updateTask(userId, task.id, { lease: { ...claimed!.lease!, expiresAt: Date.now() - 1 } });

  await recoverMissionsForOwner(userId, enqueue);
  const afterMission = await getMission(userId, mission.id);
  assert.equal(afterMission?.status, "blocked");
  assert.doesNotMatch(afterMission?.nextAction ?? "", /provider receipt|read-back/i);
  assert.match(afterMission?.nextAction ?? "", /checkpoint|task events|native-only/i);
});

test("sweeper performs one bounded automatic repair for a no-progress mission task", async () => {
  const userId = 981005;
  const mission = await runningMission(userId, "no-progress-repair");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  await updateTask(userId, task.id, { maxAttempts: 1 });
  const claimed = await claimTask(userId, task.id, "stuck-worker", 60_000);
  assert.ok(claimed?.lease);
  await settleTaskRun(userId, task.id, claimed!.lease!.token, {
    status: "failed",
    message: "Mission worker ended the slice without persisting progress.",
    failureClass: "no_progress",
  });
  assert.equal((await getMission(userId, mission.id))?.status, "failed");

  const report = await recoverMissionsForOwner(userId, enqueue);
  const repaired = await getMission(userId, mission.id);
  const repairedTask = await getTask(userId, task.id);
  assert.equal(report.repaired, 1);
  assert.equal(repaired?.status, "running");
  assert.equal(repairedTask?.status, "queued");
  assert.equal(repairedTask?.attempt, 0);
  assert.ok(repaired?.events.some((event) => /repaired|reactivated|recovered/i.test(event.message)));

  const second = await recoverMissionsForOwner(userId, enqueue);
  assert.equal(second.republished, 0, `Automatic repair must be bounded and idempotent: ${JSON.stringify(second)}`);
});

test("sweeper never auto-repairs a failed task with an uncertain provider outcome", async () => {
  const userId = 981006;
  const mission = await runningMission(userId, "uncertain-no-replay");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id)!;
  await updateTask(userId, task.id, { maxAttempts: 1 });
  const claimed = await claimTask(userId, task.id, "uncertain-worker", 60_000);
  assert.ok(claimed?.lease);
  await settleTaskRun(userId, task.id, claimed!.lease!.token, {
    status: "failed",
    message: "Provider outcome is uncertain after a timeout.",
    failureClass: "provider_uncertain",
  });

  const report = await recoverMissionsForOwner(userId, enqueue);
  const after = await getMission(userId, mission.id);
  const afterTask = await getTask(userId, task.id);
  assert.equal(report.repaired, 0);
  assert.equal(after?.status, "failed");
  assert.equal(afterTask?.status, "failed");
  assert.match(after?.nextAction ?? "", /repair|replan/i);
});
