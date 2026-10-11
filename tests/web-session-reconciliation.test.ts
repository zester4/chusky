import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createTask,
  getSession,
  getTask,
  initStore,
  mutateSession,
  saveSession,
  updateTask,
} from "../src/store.js";
import {
  ensureWebSessionReconciliationTask,
  executeWebSessionReconciliationTask,
  recoverWebSessionReconciliationTasks,
  webSessionReconciliationTaskId,
} from "../src/webSessionReconciliation.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("web history reconciliation is persisted and published through one stable task", async () => {
  const sourceUserId = 991101;
  const telegramUserId = 991102;
  const publications: string[] = [];
  const enqueuer = async (_userId: number, taskId: string) => {
    publications.push(taskId);
    return "workflow-web-reconcile-stable";
  };

  const first = await ensureWebSessionReconciliationTask(sourceUserId, telegramUserId, enqueuer);
  assert.equal(first.task.id, webSessionReconciliationTaskId(sourceUserId, telegramUserId));
  assert.equal(first.task.taskKind, "web_session_reconciliation");
  assert.deepEqual(first.task.webSessionReconciliation, { sourceUserId, telegramUserId });
  assert.equal(first.task.workflowRunId, "workflow-web-reconcile-stable");

  const second = await ensureWebSessionReconciliationTask(sourceUserId, telegramUserId, async () => {
    throw new Error("the stable task must not be published twice");
  });
  assert.equal(second.task.id, first.task.id);
  assert.deepEqual(publications, [first.task.id]);
  assert.equal((await getTask(sourceUserId, first.task.id))?.workflowRunId, "workflow-web-reconcile-stable");
});

test("the durable reconciliation worker imports private web history and is replay-safe", async () => {
  const sourceUserId = 991103;
  const telegramUserId = 991104;
  const source = await getSession(sourceUserId);
  source.history = [{ role: "user", content: "A durable web message", createdAt: Date.now() - 1_000 }];
  await saveSession(sourceUserId, source);

  const { task } = await ensureWebSessionReconciliationTask(sourceUserId, telegramUserId, async () => "workflow-web-reconcile-worker");
  const first = await executeWebSessionReconciliationTask(task);
  assert.equal(first.status, "completed");
  assert.equal((await getSession(telegramUserId)).history.some((message) => message.content === "A durable web message"), true);

  const second = await executeWebSessionReconciliationTask(task);
  assert.equal(second.status, "completed");
  const merged = await getSession(telegramUserId);
  assert.equal(merged.history.filter((message) => message.content === "A durable web message").length, 1);
});

test("lease contention becomes a durable future retry instead of blocking the request", async () => {
  const sourceUserId = 991105;
  const telegramUserId = 991106;
  const { task } = await ensureWebSessionReconciliationTask(sourceUserId, telegramUserId, async () => "workflow-web-reconcile-contention");
  let releaseHolder!: () => void;
  let holderStarted!: () => void;
  const holderReady = new Promise<void>((resolve) => { holderStarted = resolve; });
  const holderReleased = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = mutateSession(telegramUserId, async () => {
    holderStarted();
    await holderReleased;
    return true;
  }, { allSdkRuns: true });
  await holderReady;

  const startedAt = performance.now();
  const outcome = await executeWebSessionReconciliationTask(task);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(outcome.status, "queued");
  assert.equal(outcome.waiting, true);
  assert.ok((outcome.runAt ?? 0) > Date.now());
  assert.ok(elapsedMs < 100, `contention path took ${elapsedMs.toFixed(1)}ms`);

  releaseHolder();
  await holder;
});

test("recovery republishes a queued reconciliation task after a publisher crash", async () => {
  const sourceUserId = 991107;
  const telegramUserId = 991108;
  const taskId = webSessionReconciliationTaskId(sourceUserId, telegramUserId);
  await createTask(sourceUserId, {
    id: taskId,
    title: "Reconcile linked web history",
    objective: "Recover the web history reconciliation.",
    runAt: Date.now() - 1,
    maxAttempts: 10,
    taskKind: "web_session_reconciliation",
    webSessionReconciliation: { sourceUserId, telegramUserId },
  });
  const publications: string[] = [];
  const first = await recoverWebSessionReconciliationTasks(async (_userId, id) => {
    publications.push(id);
    return "workflow-web-reconcile-recovered";
  }, { maxOwners: 10_000 });
  assert.equal(first.republished, 1);
  assert.deepEqual(publications, [taskId]);
  assert.equal((await getTask(sourceUserId, taskId))?.workflowRunId, "workflow-web-reconcile-recovered");

  const second = await recoverWebSessionReconciliationTasks(async () => {
    throw new Error("a live workflow must not be duplicated");
  }, { maxOwners: 10_000 });
  assert.equal(second.republished, 0);
});

test("recovery requeues an expired reconciliation lease after a worker crash", async () => {
  const sourceUserId = 991109;
  const telegramUserId = 991110;
  const taskId = webSessionReconciliationTaskId(sourceUserId, telegramUserId);
  const task = await createTask(sourceUserId, {
    id: taskId,
    title: "Reconcile linked web history",
    objective: "Recover a crashed web history reconciliation worker.",
    runAt: Date.now() - 1,
    maxAttempts: 10,
    taskKind: "web_session_reconciliation",
    webSessionReconciliation: { sourceUserId, telegramUserId },
  });
  const expiredAt = Date.now() - 1_000;
  const running = await updateTask(sourceUserId, task.id, {
    status: "running",
    lease: {
      token: "crashed-worker-token",
      workerId: "crashed-worker",
      acquiredAt: expiredAt - 1_000,
      expiresAt: expiredAt,
    },
  });
  assert.equal(running?.status, "running");

  const publications: string[] = [];
  const report = await recoverWebSessionReconciliationTasks(async (_userId, id) => {
    publications.push(id);
    return "workflow-web-reconcile-expired-lease";
  }, { maxOwners: 10_000, now: Date.now() });

  assert.equal(report.republished, 1);
  assert.deepEqual(publications, [taskId]);
  const recovered = await getTask(sourceUserId, taskId);
  assert.equal(recovered?.status, "queued");
  assert.equal(recovered?.lease, undefined);
  assert.equal(recovered?.workflowRunId, "workflow-web-reconcile-expired-lease");
});
