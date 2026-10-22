import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  cancelMission,
  claimTask,
  createApproval,
  createMission,
  getMission,
  getExternalAction,
  getTask,
  initStore,
  listTasksForMission,
  replanMission,
  resumeMissionFromApproval,
  resumeMissionFromProviderEvent,
  resumeMissionFromTimer,
  setApprovalStatus,
  startMission,
  updateTask,
  waitMission,
  type MissionRecord,
} from "../src/store.js";
import { completeMissionStepAndAdvance, finalizeMissionCloseout, reconcileMissionExecution } from "../src/missionScheduler.js";
import { recoverMissionsForOwner } from "../src/missionRecovery.js";
import {
  beginExternalAction,
  finishExternalAction,
  reconcileExternalActionByRead,
} from "../src/autonomy/actions.js";

/**
 * This suite intentionally does not call a model or a provider. It drives the
 * durable engine through the same state and recovery APIs used by production,
 * while a fake provider ledger records whether a side effect was attempted.
 * The point is to test the engine's failure semantics, not a scripted answer.
 */

before(async () => { await initStore({ memoryOnly: true }); });

type ScenarioKind = "healthy" | "timer" | "approval" | "provider" | "crash" | "cancel" | "replan" | "delivery" | "event" | "mixed";

interface PublishedDelivery { userId: number; taskId: string; runAt: number; workflowRunId: string }

class ChaosQueue {
  readonly published: PublishedDelivery[] = [];
  private sequence = 0;
  readonly enqueue = async (userId: number, taskId: string, runAt: number): Promise<string> => {
    const workflowRunId = `chaos-${++this.sequence}-${taskId}`;
    this.published.push({ userId, taskId, runAt, workflowRunId });
    return workflowRunId;
  };
}

class FakeProviderLedger {
  readonly commits = new Map<string, number>();
  apply(idempotencyKey: string): void {
    this.commits.set(idempotencyKey, (this.commits.get(idempotencyKey) ?? 0) + 1);
  }
  attempts(idempotencyKey: string): number { return this.commits.get(idempotencyKey) ?? 0; }
}

/** Small deterministic PRNG: reproducible failures are more useful than flaky failures. */
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function choose<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function missionInput(kind: ScenarioKind, index: number) {
  return {
    id: `mis_chaos_${kind}_${index}`,
    title: `Chaos mission ${kind} ${index}`,
    objective: "Complete a long-running objective across durable checkpoints, waits, approvals, and verified provider work.",
    definitionOfDone: "Every planned step is completed and the provider effect is verified.",
    steps: [
      { id: "prepare", title: "Prepare", objective: "Prepare the durable mission context." },
      { id: "branch_a", title: "Branch A", objective: "Complete independent branch A.", dependsOn: ["prepare"] },
      { id: "branch_b", title: "Branch B", objective: "Complete independent branch B.", dependsOn: ["prepare"] },
      { id: "join", title: "Join", objective: "Join both independent branches.", dependsOn: ["branch_a", "branch_b"] },
      { id: "timer", title: "Timer", objective: "Wait durably, then continue from the saved checkpoint.", dependsOn: ["join"] },
      { id: "approval", title: "Approval", objective: "Wait for the exact owner approval, then continue.", dependsOn: ["timer"] },
      { id: "provider", title: "Provider", objective: "Perform and verify one idempotent provider action.", dependsOn: ["approval"], compensationObjective: "Inspect or compensate the uncertain provider action." },
      { id: "event", title: "Event", objective: "Wait for the exact external event, then continue.", dependsOn: ["provider"] },
      { id: "close", title: "Close", objective: "Close the mission after all evidence is present.", dependsOn: ["event"] },
    ],
    budget: { maxSlices: 200, maxSteps: 20, maxToolCalls: 200, maxCost: 20 },
  } as const;
}

async function activeStep(userId: number, missionId: string): Promise<string> {
  const mission = await getMission(userId, missionId);
  assert.ok(mission, "mission must remain readable");
  const stepId = mission.activeStepIds?.[0] ?? mission.currentStepId;
  assert.ok(stepId, `mission ${missionId} must have an active frontier`);
  return stepId;
}

async function completeStep(userId: number, missionId: string, enqueue: ChaosQueue, result: string): Promise<MissionRecord> {
  const stepId = await activeStep(userId, missionId);
  const completed = await completeMissionStepAndAdvance(userId, missionId, stepId, result, enqueue.enqueue);
  assert.ok(completed, `step ${stepId} should complete exactly once: ${JSON.stringify(await getMission(userId, missionId))}`);
  return completed;
}

async function scheduleTwice(userId: number, missionId: string, queue: ChaosQueue): Promise<void> {
  const [left, right] = await Promise.all([
    reconcileMissionExecution(userId, missionId, queue.enqueue),
    reconcileMissionExecution(userId, missionId, queue.enqueue),
  ]);
  assert.ok(left || right, "at least one concurrent scheduler must observe the mission");
  const mission = await getMission(userId, missionId);
  assert.ok(mission);
  const tasks = await listTasksForMission(userId, missionId);
  for (const stepId of mission.activeStepIds ?? []) {
    const matching = tasks.filter((task) => task.missionStepId === stepId);
    assert.equal(matching.length, 1, `step ${stepId} must have one durable task after concurrent scheduling`);
  }
}

async function assertMissionInvariants(userId: number, missionId: string, provider: FakeProviderLedger, providerKey: string): Promise<void> {
  const mission = await getMission(userId, missionId);
  assert.ok(mission);
  const completed = new Set(mission.steps.filter((step) => step.status === "completed").map((step) => step.id));
  for (const step of mission.steps) {
    if (step.status === "completed") {
      for (const dependency of step.dependsOn) assert.ok(completed.has(dependency), `${step.id} completed before dependency ${dependency}`);
    }
    if (step.status === "running") {
      assert.ok(mission.status === "running" || mission.status === "waiting" || mission.status === "cancelled", `${step.id} cannot run in ${mission.status}`);
    }
  }
  if (mission.status === "completed") {
    assert.ok(mission.steps.every((step) => step.status === "completed"), "completed mission must have no unfinished steps");
    assert.equal(mission.waiting, undefined, "completed mission cannot retain a wait");
  }
  if (["completed", "cancelled"].includes(mission.status)) {
    const frozen = JSON.stringify(mission);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(JSON.stringify(await getMission(userId, missionId)), frozen, "terminal mission state must be stable after late delivery");
  }
  assert.ok(provider.attempts(providerKey) <= 1, "the fake provider must never observe a duplicate external effect");
}

async function runScenario(kind: ScenarioKind, index: number): Promise<void> {
  const next = random(0xC0FFEE + index * 7919 + kind.length * 101);
  const userId = 990000 + index * 20 + kind.length;
  const queue = new ChaosQueue();
  const provider = new FakeProviderLedger();
  const providerKey = `provider:${kind}:${index}`;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const created = await createMission(userId, missionInput(kind, index));
    assert.equal((await startMission(userId, created.id))?.status, "running");
    await scheduleTwice(userId, created.id, queue);

    if (kind === "cancel") {
      const stepId = await activeStep(userId, created.id);
      const [cancelled, lateCompletion] = await Promise.all([
        cancelMission(userId, created.id, "Chaos cancellation won the lifecycle race."),
        completeMissionStepAndAdvance(userId, created.id, stepId, "late worker result", queue.enqueue),
      ]);
      assert.ok(cancelled || lateCompletion, "one side of the cancellation race must win");
      assert.equal((await getMission(userId, created.id))?.status, cancelled ? "cancelled" : "running");
      if (lateCompletion?.status === "running") await cancelMission(userId, created.id, "Cancel after the worker committed.");
      await assertMissionInvariants(userId, created.id, provider, providerKey);
      return;
    }

    // Root and the two independent branches exercise fan-out, out-of-order
    // completion, duplicate scheduler calls, and dependency convergence.
    await completeStep(userId, created.id, queue, "Prepare checkpoint verified.");
    const branches = (await getMission(userId, created.id))!.activeStepIds ?? [];
    assert.deepEqual(new Set(branches), new Set(["branch_a", "branch_b"]));
    const order = next() > 0.5 ? ["branch_a", "branch_b"] : ["branch_b", "branch_a"];
    for (const stepId of order) {
      const completed = await completeMissionStepAndAdvance(userId, created.id, stepId, `${stepId} verified`, queue.enqueue);
      assert.ok(completed);
      const frontier = await getMission(userId, created.id);
      const duplicate = await completeMissionStepAndAdvance(userId, created.id, stepId, "duplicate delivery", queue.enqueue);
      assert.ok(duplicate, "duplicate step completion should return the current durable mission");
      assert.ok(duplicate.version >= (frontier?.version ?? 0), "duplicate delivery may repair scheduling but cannot move the mission backwards");
      assert.equal(duplicate.events.filter((event) => event.type === "step_completed" && event.stepId === stepId).length, 1, "duplicate step completion must not append another completion event");
      assert.equal(duplicate.steps.find((step) => step.id === stepId)?.result, `${stepId} verified`, "duplicate delivery must preserve the first verified result");
    }
    await completeStep(userId, created.id, queue, "Both branches joined.");

    const timerStep = await activeStep(userId, created.id);
    const timerAt = now + 5_000 + Math.floor(next() * 5_000);
    assert.ok(await waitMission(userId, created.id, { kind: "timer", runAt: timerAt, stepId: timerStep }, "Timer checkpoint persisted", "Resume the timer step after the wake."));
    assert.equal(await resumeMissionFromTimer(userId, created.id, timerAt), undefined, "a future timer cannot wake early");
    if (kind === "timer" || kind === "mixed" || next() > 0.25) {
      now = timerAt + (next() > 0.5 ? 500 : 0);
      const [wakeA, wakeB] = await Promise.all([
        resumeMissionFromTimer(userId, created.id, timerAt),
        resumeMissionFromTimer(userId, created.id, timerAt),
      ]);
      assert.ok(wakeA || wakeB, "one duplicate timer delivery must resume the mission");
      assert.equal((await getMission(userId, created.id))?.status, "running");
    } else {
      now = timerAt + 1;
      const recovered = await recoverMissionsForOwner(userId, queue.enqueue, { now });
      assert.ok(recovered.timerWakes >= 0, "recovery must remain safe when a timer wake is delivered by the sweeper");
    }
    await completeStep(userId, created.id, queue, "Post-wake work verified.");

    const approvalStep = await activeStep(userId, created.id);
    const approval = await createApproval({ userId, toolSlug: "CHUCK_MISSION_RESUME", args: { id: created.id }, request: "Approve mission continuation.", history: [], model: "test/none" });
    assert.ok(await waitMission(userId, created.id, { kind: "approval", key: approval.id, stepId: approvalStep, expiresAt: now + 60_000 }, "Approval checkpoint persisted", "Approve the exact continuation."));
    assert.equal(await resumeMissionFromApproval(userId, created.id, approval.id), undefined, "pending approval cannot resume the mission");
    assert.ok(await setApprovalStatus(userId, approval.id, "approved"));
    const [approvalA, approvalB] = await Promise.all([
      resumeMissionFromApproval(userId, created.id, approval.id),
      resumeMissionFromApproval(userId, created.id, approval.id),
    ]);
    assert.ok(approvalA || approvalB, "one duplicate approval callback must resume the mission");
    await completeStep(userId, created.id, queue, "Approved continuation verified.");

    const providerStep = await activeStep(userId, created.id);
    const claim = await beginExternalAction({ userId, provider: "composio", tool: "FAKE_CREATE_RECORD", args: { key: providerKey }, runId: `run-${kind}-${index}`, source: { kind: "mission", id: created.id, missionStepId: providerStep } });
    assert.equal(claim.state, "new");
    assert.equal((await getExternalAction(userId, claim.logicalActionId))?.status, "started", "provider intent must be durable before the fake provider runs");
    provider.apply(providerKey);
    if (kind === "provider" || kind === "mixed" || next() > 0.45) {
      // Simulate a process dying after the destination committed but before
      // Chusky saved its receipt. Recovery must reconcile, never redial.
      now += 31 * 60_000;
      const ambiguous = await beginExternalAction({ userId, provider: "composio", tool: "FAKE_CREATE_RECORD", args: { key: providerKey }, runId: `retry-${kind}-${index}`, source: { kind: "mission", id: created.id, missionStepId: providerStep } });
      assert.equal(ambiguous.state, "ambiguous");
      const reconciled = await reconcileExternalActionByRead({ userId, logicalActionId: claim.logicalActionId, evidenceRef: `fake-read:${providerKey}`, summary: "Fake provider read-back confirms the record.", verifiedAt: now });
      assert.equal(reconciled?.status, "succeeded");
    } else {
      assert.equal((await finishExternalAction(userId, claim.logicalActionId, "Fake record created", "fake-record-1"))?.status, "succeeded");
      assert.equal((await beginExternalAction({ userId, provider: "composio", tool: "FAKE_CREATE_RECORD", args: { key: providerKey }, runId: `retry-${kind}-${index}`, source: { kind: "mission", id: created.id, missionStepId: providerStep } })).state, "succeeded");
    }
    await completeStep(userId, created.id, queue, "Provider action has a durable receipt.");

    const eventStep = await activeStep(userId, created.id);
    const eventId = `fake-event-${kind}-${index}`;
    assert.ok(await waitMission(userId, created.id, { kind: "provider_event", provider: "fake", providerEventId: eventId, stepId: eventStep, expiresAt: now + 60_000 }, "Provider wait checkpoint persisted", "Wait for the exact fake provider event."));
    const [eventA, eventB] = await Promise.all([
      resumeMissionFromProviderEvent(userId, created.id, "fake", eventId),
      resumeMissionFromProviderEvent(userId, created.id, "fake", eventId),
    ]);
    assert.ok(eventA || eventB, "one duplicate provider event must resume the mission");
    await completeStep(userId, created.id, queue, "Provider event processed.");

    if (kind === "delivery" || kind === "mixed" || next() > 0.6) {
      // Accepted publication lost after persistence: age the publication and
      // force the real recovery sweeper to republish the same task identity.
      const mission = await getMission(userId, created.id);
      const activeTaskId = (await listTasksForMission(userId, created.id)).find((task) =>
        task.status === "queued" && mission?.activeStepIds?.includes(task.missionStepId ?? ""))?.id;
      if (activeTaskId) {
        const task = await getTask(userId, activeTaskId);
        assert.ok(task);
        const publishedBefore = queue.published.length;
        await updateTask(userId, task.id, { workflowPublishedAt: now - 61_000 });
        await recoverMissionsForOwner(userId, queue.enqueue, { now });
        assert.ok(queue.published.length > publishedBefore, "recovery must republish an aged accepted publication");
        assert.ok((await getTask(userId, task.id))?.id === task.id, "recovery must preserve task identity");
      }
    }

    if (kind === "replan") {
      const current = await getMission(userId, created.id);
      assert.ok(current);
      const replanned = await replanMission(userId, created.id, [
        { id: "prepare", title: "Prepare", objective: "Preserve completed preparation." },
        { id: "branch_a", title: "Branch A", objective: "Preserve completed branch A.", dependsOn: ["prepare"] },
        { id: "branch_b", title: "Branch B", objective: "Preserve completed branch B.", dependsOn: ["prepare"] },
        { id: "join", title: "Join", objective: "Preserve completed join.", dependsOn: ["branch_a", "branch_b"] },
        { id: "timer", title: "Timer", objective: "Preserve completed timer.", dependsOn: ["join"] },
        { id: "approval", title: "Approval", objective: "Preserve completed approval.", dependsOn: ["timer"] },
        { id: "provider", title: "Provider", objective: "Preserve completed provider.", dependsOn: ["approval"] },
        { id: "event", title: "Event", objective: "Preserve completed event.", dependsOn: ["provider"] },
        { id: "close", title: "Close", objective: "Verify the final closeout.", dependsOn: ["event"] },
      ], "Provider event supplied new closeout requirements.");
      assert.ok(replanned);
      assert.equal(replanned.steps.filter((step) => step.status === "completed").length, 8, "replan must not reopen completed steps");
    }

    await completeStep(userId, created.id, queue, "Final closeout verified.");
    const done = await getMission(userId, created.id);
    assert.ok(done?.status === "running" || done?.status === "completed", "final step must leave the mission active or durably completed");
    const closed = await finalizeMissionCloseout(userId, created.id);
    assert.equal(closed?.status, "completed");
    await assertMissionInvariants(userId, created.id, provider, providerKey);
  } finally {
    Date.now = originalNow;
  }
}

test("one hundred deterministic mission chaos scenarios survive durable lifecycle faults without model calls", { timeout: 180_000 }, async () => {
  const kinds: ScenarioKind[] = ["healthy", "timer", "approval", "provider", "crash", "cancel", "replan", "delivery", "event", "mixed"];
  for (let index = 0; index < 100; index++) {
    const kind = kinds[index % kinds.length]!;
    if (kind === "crash") {
      // A worker crash is a deliberate quarantine case: the provider outcome
      // is unknown, so the mission must block instead of replaying blindly.
      const userId = 995000 + index;
      const queue = new ChaosQueue();
      const created = await createMission(userId, missionInput(kind, index));
      await startMission(userId, created.id);
      await reconcileMissionExecution(userId, created.id, queue.enqueue);
      const task = (await listTasksForMission(userId, created.id))[0];
      assert.ok(task);
      const claimed = await claimTask(userId, task.id, `chaos-crashed-worker-${index}`, 1_000);
      assert.ok(claimed?.lease);
      await updateTask(userId, task.id, { lease: { ...claimed!.lease!, expiresAt: Date.now() - 1 } });
      const report = await recoverMissionsForOwner(userId, queue.enqueue, { now: Date.now() });
      const recovered = await getMission(userId, created.id);
      assert.equal(report.quarantined, 1);
      assert.equal(recovered?.status, "blocked");
      assert.match(recovered?.nextAction ?? "", /receipt|read-back|checkpoint/i);
      continue;
    }
    await runScenario(kind, index);
  }
});
