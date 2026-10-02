import test, { before } from "node:test";
import assert from "node:assert/strict";
import { claimTask, completeMissionStep, completeTask, createMission, createTask, finalizeMissionIfReady, getMission, getTask, initStore, listTasks, recordTrustedMissionEvidence, renewTaskLease, settleTaskRun, startMission, updateTask } from "../src/store.js";
import { scheduleMissionSteps } from "../src/missionScheduler.js";
import { executeDurableTask } from "../src/taskRunner.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("an expired running task is reclaimed with a new token and rejects the crashed worker", async () => {
  const userId = 840009;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const task = await createTask(userId, { title: "Recover a crash", objective: "Continue the same durable task" });
    const crashed = await claimTask(userId, task.id, "crashed-worker", 1000);
    assert.ok(crashed?.lease);
    now += 1001;
    const recovered = await claimTask(userId, task.id, "replacement-worker", 1000);
    assert.ok(recovered?.lease, "An expired running lease must not strand the task.");
    assert.equal(recovered.id, task.id);
    assert.notEqual(recovered.lease.token, crashed.lease.token);
    assert.equal(await renewTaskLease(userId, task.id, crashed.lease.token, 1000), undefined);
    assert.equal(await settleTaskRun(userId, task.id, crashed.lease.token, { status: "completed", message: "Late stale result" }), undefined);
    const settled = await settleTaskRun(userId, task.id, recovered.lease.token, { status: "completed", message: "Recovered", result: "Verified" });
    assert.equal(settled?.status, "completed");
  } finally {
    Date.now = originalNow;
  }
});

test("lease expiry revokes settlement and renewal even before a replacement claims", async () => {
  const userId = 840010;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const task = await createTask(userId, { title: "Expired authority", objective: "Reject expired worker writes" });
    const claimed = await claimTask(userId, task.id, "expired-worker", 1000);
    assert.ok(claimed?.lease);
    now += 1000;
    assert.equal(await renewTaskLease(userId, task.id, claimed.lease.token, 1000), undefined);
    assert.equal(await settleTaskRun(userId, task.id, claimed.lease.token, { status: "completed", message: "Expired result" }), undefined);
    assert.equal((await getTask(userId, task.id))?.status, "running");
  } finally {
    Date.now = originalNow;
  }
});

test("only one worker can claim a queued task and the stale worker cannot settle it", async () => {
  const userId = 840001;
  const task = await createTask(userId, { title: "Run once", objective: "Verify leasing" });
  let executions = 0;
  const worker = (workerId: string) => executeDurableTask({ userId, taskId: task.id }, {
    workerId,
    execute: async () => { executions++; return { status: "completed" as const, message: "done", result: "verified" }; },
  });
  const [first, second] = await Promise.all([worker("worker-a"), worker("worker-b")]);
  assert.equal(executions, 1);
  assert.equal([first.claimed, second.claimed].filter(Boolean).length, 1);
  assert.equal((await getTask(userId, task.id))?.status, "completed");
  assert.equal(await settleTaskRun(userId, task.id, "stale-token", { status: "failed", message: "should not write" }), undefined);
});

test("an unclaimable wake returns the current queued or leased task state", async () => {
  const userId = 840006;
  const task = await createTask(userId, { title: "Racing wake", objective: "Preserve the continuation" });
  const owner = await claimTask(userId, task.id, "existing-worker", 120_000);
  assert.ok(owner?.lease);

  const run = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "racing-worker",
    execute: async () => ({ status: "completed" as const, message: "must not execute" }),
  });

  assert.equal(run.claimed, false);
  assert.equal(run.task?.id, task.id);
  assert.equal(run.task?.status, "running");

  const queuedTask = await createTask(userId, { title: "Future wake", objective: "Preserve the wake time" });
  const runAt = Date.now() + 60_000;
  await updateTask(userId, queuedTask.id, { runAt });
  const queuedRun = await executeDurableTask({ userId, taskId: queuedTask.id }, {
    workerId: "early-wake-worker",
    execute: async () => ({ status: "completed" as const, message: "must not execute" }),
  });
  assert.equal(queuedRun.claimed, false);
  assert.equal(queuedRun.task?.status, "queued");
  assert.equal(queuedRun.task?.runAt, runAt);
});

test("an intentional task wait resumes without consuming another retry attempt", async () => {
  const userId = 840007;
  const task = await createTask(userId, { title: "Wake once", objective: "Continue after a durable wait", maxAttempts: 1 });
  const runAt = Date.now() + 60_000;
  const parked = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "wait-worker",
    execute: async () => ({ status: "queued" as const, waiting: true, message: "Parked", runAt, checkpoint: "Before wait", nextAction: "Execute after wake" }),
  });
  assert.equal(parked.task?.status, "queued");
  assert.equal(parked.task?.attempt, 1);

  await updateTask(userId, task.id, { runAt: Date.now() - 1 });
  const continued = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "wait-worker-after-wake",
    execute: async () => ({ status: "completed" as const, message: "Continued" }),
  });
  assert.equal(continued.task?.status, "completed");
  assert.equal(continued.task?.attempt, 1);
});

test("transient worker failures are retried with a bounded delayed requeue", async () => {
  const userId = 840002;
  const task = await createTask(userId, { title: "Retry", objective: "Exercise backoff", maxAttempts: 2 });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "worker", execute: async () => { throw new Error("temporary provider outage"); } });
  assert.equal(run.claimed, true);
  assert.equal(run.task?.status, "queued");
  assert.equal(run.task?.attempt, 1);
  assert.ok((run.task?.runAt ?? 0) > Date.now());
  assert.equal(run.task?.events.at(-1)?.type, "failed");
});

test("a task stops retrying once its bounded attempt budget is exhausted", async () => {
  const userId = 840004;
  const task = await createTask(userId, { title: "Bounded retry", objective: "Do not loop forever", maxAttempts: 1 });
  const run = await executeDurableTask({ userId, taskId: task.id }, { workerId: "worker", execute: async () => { throw new Error("permanent failure"); } });
  assert.equal(run.task?.status, "failed");
  assert.equal(run.task?.attempt, 1);
  assert.equal(run.task?.runAt, undefined);
});

test("blocked executions retain their checkpoint and emit an audit event", async () => {
  const userId = 840003;
  const task = await createTask(userId, { title: "Needs approval", objective: "Stop safely" });
  const run = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "worker",
    execute: async () => ({ status: "blocked", message: "Approval required", checkpoint: "Read-only inspection completed", nextAction: "Approve the proposed action" }),
  });
  assert.equal(run.task?.status, "blocked");
  assert.equal(run.task?.checkpoint, "Read-only inspection completed");
  assert.equal(run.task?.nextAction, "Approve the proposed action");
  assert.equal(run.task?.events.at(-1)?.type, "blocked");
});

test("an in-turn task completion is not misreported as a lost lease failure", async () => {
  const userId = 840005;
  const task = await createTask(userId, { title: "Complete in turn", objective: "Exercise lifecycle handoff" });
  const run = await executeDurableTask({ userId, taskId: task.id }, {
    workerId: "worker",
    execute: async () => {
      await completeTask(userId, task.id, "Verified completion from the current worker.");
      throw new DOMException("Task was settled by the current worker.", "AbortError");
    },
  });
  assert.equal(run.task?.status, "completed");
  assert.match(run.task?.result ?? "", /Verified completion/);
});

test("the durable worker can carry a receipt-gated mission slice to completion", async () => {
  const userId = 840008;
  const mission = await createMission(userId, {
    title: "Golden mission",
    objective: "Complete one provider-backed step durably.",
    definitionOfDone: "The provider receipt is attached and the step is complete.",
    requiredEvidence: ["kind:tool_receipt"],
    steps: [{ id: "send", title: "Send", objective: "Perform the provider action", evidenceRequired: ["kind:tool_receipt"], allowedTools: ["GMAIL_SEND_EMAIL"] }],
  });
  const started = await startMission(userId, mission.id);
  const published: string[] = [];
  await scheduleMissionSteps(userId, started!, async (_ownerId, taskId) => { published.push(taskId); return `workflow_${taskId}`; });
  const task = (await listTasks(userId)).find((candidate) => candidate.missionId === mission.id);
  assert.ok(task);
  assert.deepEqual(task!.missionAllowedTools, ["GMAIL_SEND_EMAIL"]);

  const run = await executeDurableTask({ userId, taskId: task!.id }, {
    workerId: "golden-mission-worker",
    execute: async (claimedTask) => {
      assert.equal(claimedTask.missionId, mission.id);
      assert.equal(claimedTask.missionStepId, "send");
      await recordTrustedMissionEvidence(userId, mission.id, [{ id: "receipt-golden", kind: "tool_receipt", summary: "Provider confirmed the send", ref: "receipt://golden", verified: true, verifiedBy: "system" }], "send");
      await completeMissionStep(userId, mission.id, "send", "Provider receipt recorded.");
      const finalized = await finalizeMissionIfReady(userId, mission.id, { blockOnUnresolved: true });
      assert.equal(finalized?.status, "completed");
      return { status: "completed" as const, message: "Mission completed", result: finalized?.result };
    },
  });

  assert.equal(published.length, 1);
  assert.equal(run.task?.status, "completed");
  assert.equal((await getMission(userId, mission.id))?.status, "completed");
});
