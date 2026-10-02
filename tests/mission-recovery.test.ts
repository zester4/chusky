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
