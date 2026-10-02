import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointMission,
  blockMission,
  cancelMission,
  completeMissionStep,
  completeMission,
  createMission,
  finalizeMissionIfReady,
  getMission,
  initStore,
  listMissionEvents,
  missionBudgetPreflight,
  pauseMission,
  recordMissionSlice,
  replanMission,
  resumeMissionFromProviderEvent,
  resumeMissionFromTimer,
  resumeMission,
  startMission,
  updateMission,
  verifyMission,
  waitMission,
  type MissionRecord,
} from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("mission event history survives the bounded mission-record tail", async () => {
  const userId = 981020;
  const mission = await createMission(userId, { title: "Event history", objective: "Retain lifecycle history", definitionOfDone: "History remains readable", steps: [{ id: "history", title: "History", objective: "Checkpoint repeatedly" }] });
  await startMission(userId, mission.id);
  for (let index = 0; index < 140; index++) await checkpointMission(userId, mission.id, `checkpoint-${index}`, `continue-${index}`);

  const current = await getMission(userId, mission.id);
  const events = await listMissionEvents(userId, mission.id, 5000);
  assert.ok((current?.events.length ?? 0) <= 500, "the mission record remains bounded");
  assert.ok(events.length > 100, "the durable history must outlive the bounded mission record");
  assert.equal(events[0]?.type, "created");
  assert.equal(events.at(-1)?.message, "continue-139");
});

test("expired mission resume stays blocked until its total duration is explicitly extended", async () => {
  const userId = 951099;
  const mission = await createMission(userId, input({ budget: { maxDurationSeconds: 60, durationMode: "wall_clock" } }));
  await startMission(userId, mission.id);
  const startedAt = Date.now() - 120_000;
  await updateMission(userId, mission.id, { startedAt });
  assert.equal(missionBudgetPreflight((await getMission(userId, mission.id))!).allowed, false);
  const blocked = await resumeMission(userId, mission.id);
  assert.equal(blocked?.status, "blocked");
  assert.equal(await completeMissionStep(userId, mission.id, blocked!.currentStepId!, "Cannot advance"), undefined);
  const resumed = await resumeMission(userId, mission.id, 300);
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.startedAt, startedAt);
  assert.equal(resumed?.budget.maxDurationSeconds, 300);
  assert.equal((await resumeMission(userId, mission.id, 300))?.budget.maxDurationSeconds, 300);
  assert.equal((await completeMissionStep(userId, mission.id, resumed!.currentStepId!, "Verified existing work"))?.steps[0]?.status, "completed");
  assert.equal(await resumeMission(userId + 1, mission.id, 300), undefined);
});

test("blocking a mission with verbose diagnostics persists a bounded recovery reason", async () => {
  const userId = 951098;
  const mission = await createMission(userId, input({ idempotencyKey: "bounded-block-reason" }));
  await startMission(userId, mission.id);
  const verboseReason = `Provider verification failed. ${"diagnostic detail ".repeat(300)}`;
  const blocked = await blockMission(userId, mission.id, verboseReason, "Inspect the provider receipt and resume this same mission.");
  assert.equal(blocked?.status, "blocked");
  assert.ok((blocked?.error?.length ?? 0) <= 2000);
  assert.ok((blocked?.events.at(-1)?.message.length ?? 0) <= 1000);
  assert.match(blocked?.error ?? "", /Provider verification failed/);
});

test("settling a slice records usage without reviving a blocked or paused mission", async () => {
  const userId = 951098;
  const mission = await createMission(userId, input());
  await startMission(userId, mission.id);
  await pauseMission(userId, mission.id);
  const accounted = await recordMissionSlice(userId, mission.id, { toolCalls: 4, cost: 0.2 });
  assert.equal(accounted?.status, "paused");
  assert.equal(accounted?.consumedSlices, 1);
  assert.equal(accounted?.toolCalls, 4);
  assert.equal(accounted?.cost, 0.2);
});

test("late slice settlement cannot mutate a cancelled mission", async () => {
  const userId = 951096;
  const mission = await createMission(userId, input({ idempotencyKey: "late-cancelled-slice" }));
  await startMission(userId, mission.id);
  const cancelled = await cancelMission(userId, mission.id, "Owner cancelled the mission.");
  assert.equal(cancelled?.status, "cancelled");

  const late = await recordMissionSlice(userId, mission.id, {
    checkpoint: "A late worker response arrived.",
    nextAction: "Ignore the cancelled continuation.",
    toolCalls: 4,
    cost: 0.2,
  });

  assert.equal(late?.status, "cancelled");
  assert.equal(late?.version, cancelled?.version);
  assert.equal(late?.checkpoint, cancelled?.checkpoint);
  assert.equal(late?.consumedSlices, cancelled?.consumedSlices);
  assert.equal(late?.toolCalls, cancelled?.toolCalls);
  assert.equal(late?.cost, cancelled?.cost);
});

test("uncertain external progress charges the slice before atomically blocking the mission", async () => {
  const userId = 951097;
  const mission = await createMission(userId, input({ idempotencyKey: "uncertain-external-slice" }));
  await startMission(userId, mission.id);
  const blocked = await recordMissionSlice(userId, mission.id, {
    checkpoint: "Before provider outcome reconciliation",
    nextAction: "Inspect the provider receipt before resuming",
    toolCalls: 2,
    cost: 0.35,
    blockedReason: "An external provider action was attempted without a durable receipt.",
  });
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.consumedSlices, 1);
  assert.equal(blocked?.toolCalls, 2);
  assert.equal(blocked?.cost, 0.35);
  assert.match(blocked?.error ?? "", /without a durable receipt/);
  assert.equal(blocked?.events.at(-1)?.type, "blocked");
});

function input(overrides: Partial<Pick<MissionRecord, "title" | "objective" | "definitionOfDone">> & { idempotencyKey?: string; budget?: Partial<MissionRecord["budget"]>; steps?: Array<{ id?: string; title: string; objective: string; dependsOn?: string[] }> } = {}) {
  return {
    title: overrides.title ?? "Prepare a verified launch brief",
    objective: overrides.objective ?? "Research the launch inputs, draft the brief, and verify every material claim.",
    definitionOfDone: overrides.definitionOfDone ?? "A reviewed brief exists and every required source is checked.",
    ...overrides,
  };
}

test("missions are owner-scoped, resumable, and complete through explicit lifecycle transitions", async () => {
  const userId = 951001;
  const created = await createMission(userId, input({ idempotencyKey: "launch-brief-1" }));
  assert.equal(created.status, "queued");
  assert.equal((await getMission(userId + 1, created.id)), undefined);

  const started = await startMission(userId, created.id);
  assert.equal(started?.status, "running");

  const checkpointed = await checkpointMission(userId, created.id, "Sources collected and claims mapped.", "Draft the brief, then verify the numbers.");
  assert.equal(checkpointed?.status, "running");
  assert.equal(checkpointed?.checkpoint, "Sources collected and claims mapped.");

  const paused = await pauseMission(userId, created.id, "Owner paused the mission.");
  assert.equal(paused?.status, "paused");
  const resumed = await resumeMission(userId, created.id);
  assert.equal(resumed?.status, "running");

  const stepDone = await completeMissionStep(userId, created.id, resumed!.currentStepId!, "Research and verification are complete.");
  assert.equal(stepDone?.steps.every((step) => step.status === "completed"), true);
  const done = await completeMission(userId, created.id, "Verified launch brief is ready.");
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "Verified launch brief is ready.");
  assert.equal((await completeMission(userId, created.id, "duplicate")), undefined);
});

test("a mission cannot be completed while any planned step is unfinished", async () => {
  const userId = 951032;
  const mission = await createMission(userId, input({ idempotencyKey: "mission-closeout-requires-all-steps", steps: [
    { id: "first", title: "First", objective: "Finish the first step." },
    { id: "second", title: "Second", objective: "Finish the second step.", dependsOn: ["first"] },
  ] }));
  await startMission(userId, mission.id);
  assert.equal(await completeMission(userId, mission.id, "Premature closeout."), undefined);
});

test("mission idempotency returns the original mission instead of starting duplicate work", async () => {
  const userId = 951002;
  const first = await createMission(userId, input({ idempotencyKey: "same-request" }));
  const second = await createMission(userId, input({ idempotencyKey: "same-request", title: "A different title" }));
  assert.equal(second.id, first.id);
  assert.equal(second.title, first.title);
});

test("mission plans reject unknown and self-referential dependencies instead of silently dropping them", async () => {
  const userId = 951030;
  await assert.rejects(() => createMission(userId, input({ idempotencyKey: "unknown-dependency", steps: [
    { id: "research", title: "Research", objective: "Collect sources.", dependsOn: ["missing"] },
  ] })), /unknown dependency/i);
  await assert.rejects(() => createMission(userId, input({ idempotencyKey: "self-dependency", steps: [
    { id: "research", title: "Research", objective: "Collect sources.", dependsOn: ["research"] },
  ] })), /depend on itself/i);
});

test("mission slice accounting blocks work when a budget is exhausted", async () => {
  const userId = 951003;
  const mission = await createMission(userId, input({ budget: { maxSteps: 2, maxToolCalls: 3, maxCost: 0.25 } }));
  await startMission(userId, mission.id);
  const accounted = await recordMissionSlice(userId, mission.id, {
    checkpoint: "One bounded slice completed.",
    nextAction: "Continue only if budget remains.",
    toolCalls: 4,
    cost: 0.01,
  });
  assert.equal(accounted?.status, "blocked");
  assert.match(accounted?.error ?? "", /budget/i);
  assert.equal(accounted?.toolCalls, 4);
});

test("mission revisions prevent lost concurrent updates and provider events resume idempotently", async () => {
  const userId = 951004;
  const mission = await createMission(userId, input({ idempotencyKey: "provider-wait-1" }));
  await startMission(userId, mission.id);
  await waitMission(userId, mission.id, { kind: "provider_event", provider: "stripe", providerEventId: "evt_123", expiresAt: Date.now() + 60_000 }, "Payment intent created.", "Wait for payment completion.");
  assert.equal(await waitMission(userId, mission.id, { kind: "provider_event", provider: "stripe", providerEventId: "evt_other", expiresAt: Date.now() + 60_000 }), undefined, "a concurrent stale worker cannot replace the mission's active wait");
  assert.equal((await getMission(userId, mission.id))?.waiting?.providerEventId, "evt_123");
  const resumed = await resumeMissionFromProviderEvent(userId, mission.id, "stripe", "evt_123");
  assert.equal(resumed?.status, "running");
  assert.equal((await resumeMissionFromProviderEvent(userId, mission.id, "stripe", "evt_123"))?.status, "running");
  assert.equal(await resumeMissionFromProviderEvent(userId, mission.id, "stripe", "evt_other"), undefined);

  const current = await getMission(userId, mission.id);
  assert.ok(current);
  const [left, right] = await Promise.allSettled([
    updateMission(userId, mission.id, { checkpoint: "left" }),
    updateMission(userId, mission.id, { checkpoint: "right" }),
  ]);
  assert.equal([left, right].filter((result) => result.status === "fulfilled").length, 2);
  const final = await getMission(userId, mission.id);
  assert.equal(final?.version, (current?.version ?? 0) + 2);
  assert.ok(final?.checkpoint === "left" || final?.checkpoint === "right");
});

test("the same durable task resumes a timer-waiting mission only after its persisted wake time", async () => {
  const userId = 951034;
  const mission = await createMission(userId, input({ idempotencyKey: "timer-wait-resume" }));
  await startMission(userId, mission.id);
  const runAt = Date.now() - 1;
  await waitMission(userId, mission.id, { kind: "timer", runAt }, "The provider is processing.", "Read the provider result after waking.");
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
  const resumed = await resumeMissionFromTimer(userId, mission.id, runAt);
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.waiting, undefined);
  assert.equal(resumed?.nextAction, "Read the provider result after waking.");
  assert.match(resumed?.events.at(-1)?.message ?? "", /Timer wait reached/);
  assert.equal(await resumeMissionFromTimer(userId, mission.id, runAt), undefined);
});

test("mission steps enforce dependency order and reject cycles", async () => {
  const userId = 951005;
  const mission = await createMission(userId, input({ idempotencyKey: "dag-1", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "brief", title: "Brief", objective: "Write the brief.", dependsOn: ["research"] },
  ] }));
  assert.equal(mission.currentStepId, "research");
  await startMission(userId, mission.id);
  assert.equal((await getMission(userId, mission.id))?.steps.find((step) => step.id === "research")?.status, "running");
  assert.equal(await completeMissionStep(userId, mission.id, "brief", "Bypass attempt"), undefined);
  const advanced = await completeMissionStep(userId, mission.id, "research", "Sources verified.");
  assert.equal(advanced?.currentStepId, "brief");
  assert.equal(advanced?.steps.find((step) => step.id === "brief")?.status, "running");
  await assert.rejects(() => createMission(userId + 1, input({ idempotencyKey: "dag-cycle", steps: [
    { id: "a", title: "A", objective: "A", dependsOn: ["b"] },
    { id: "b", title: "B", objective: "B", dependsOn: ["a"] },
  ] })), /dependency cycle|dependency-free/);
});

test("mission step completion is idempotent for a replay but never revives cancellation", async () => {
  const userId = 951008;
  const mission = await createMission(userId, input({ idempotencyKey: "step-replay", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
  ] }));
  await startMission(userId, mission.id);
  const first = await completeMissionStep(userId, mission.id, "research", "Original verified result.");
  const replay = await completeMissionStep(userId, mission.id, "research", "A retry must not overwrite this.");
  assert.equal(replay?.id, first?.id);
  assert.equal(replay?.steps.find((step) => step.id === "research")?.result, "Original verified result.");
  await cancelMission(userId, mission.id, "Owner stopped the mission.");
  assert.equal(await completeMissionStep(userId, mission.id, "research", "Late replay."), undefined);
});

test("waiting mission steps cannot be completed or checkpointed by a stale worker", async () => {
  const userId = 951031;
  const mission = await createMission(userId, input({ idempotencyKey: "mission-wait-completion-gate", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
  ] }));
  await startMission(userId, mission.id);
  await waitMission(userId, mission.id, { kind: "provider_event", provider: "crm", providerEventId: "evt-wait-gate", expiresAt: Date.now() + 60_000 });
  assert.equal(await completeMissionStep(userId, mission.id, "research", "Stale worker result."), undefined);
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
  assert.equal(await checkpointMission(userId, mission.id, "This must not clear the event wait."), undefined);
  assert.equal((await getMission(userId, mission.id))?.waiting?.providerEventId, "evt-wait-gate");
});

test("server-side mission closeout completes legacy work after the final slice", async () => {
  const userId = 951009;
  const mission = await createMission(userId, input({ idempotencyKey: "server-closeout-legacy", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
  ] }));
  const started = await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Sources collected.");
  const finalized = await finalizeMissionIfReady(userId, mission.id);
  assert.equal(finalized?.status, "completed");
  assert.match(finalized?.result ?? "", /Research/);
});

test("concurrent mission closeout callers return the persisted completed state", async () => {
  const userId = 951013;
  const mission = await createMission(userId, input({ idempotencyKey: "concurrent-closeout", steps: [
    { id: "only", title: "Only", objective: "Complete" },
  ] }));
  const started = await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Verified result.");

  const closeouts = await Promise.all([
    finalizeMissionIfReady(userId, mission.id),
    finalizeMissionIfReady(userId, mission.id),
  ]);
  assert.deepEqual(closeouts.map((record) => record?.status), ["completed", "completed"]);
  assert.equal((await getMission(userId, mission.id))?.status, "completed");
});

test("strict server-side closeout blocks honestly until evidence verifies", async () => {
  const userId = 951010;
  const mission = await createMission(userId, input({ idempotencyKey: "server-closeout-strict", requiredEvidence: ["kind:tool_receipt"], verificationMode: "strict", steps: [
    { id: "send", title: "Send", objective: "Perform the approved action." },
  ] }));
  const started = await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Action completed.");
  const blocked = await finalizeMissionIfReady(userId, mission.id, { blockOnUnresolved: true });
  assert.equal(blocked?.status, "blocked");
  assert.match(blocked?.nextAction ?? "", /evidence|verify/i);
});

test("server closeout does not override an owner-paused mission", async () => {
  const userId = 951012;
  const mission = await createMission(userId, input({ idempotencyKey: "paused-closeout", steps: [
    { id: "only", title: "Only", objective: "Complete" },
  ] }));
  const started = await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Verified result");
  const paused = await pauseMission(userId, mission.id, "Owner paused this mission before closeout.");
  assert.equal(paused?.status, "paused");
  const unchanged = await finalizeMissionIfReady(userId, mission.id, { blockOnUnresolved: true });
  assert.equal(unchanged?.status, "paused");
  const resumed = await resumeMission(userId, mission.id);
  assert.equal(resumed?.status, "running");
  const completed = await finalizeMissionIfReady(userId, mission.id, { blockOnUnresolved: true });
  assert.equal(completed?.status, "completed");
});

test("strict missions cannot be created or verified without evidence criteria", async () => {
  const userId = 951011;
  await assert.rejects(
    () => createMission(userId, input({ idempotencyKey: "strict-without-evidence", verificationMode: "strict" })),
    /requires at least one non-empty required evidence criterion/i,
  );
  await assert.rejects(
    () => createMission(userId, input({ idempotencyKey: "strict-blank-evidence", verificationMode: "strict", requiredEvidence: ["  "] })),
    /requires at least one non-empty required evidence criterion/i,
  );

  // Fail closed for strict records created by older code or migrated data.
  const legacy = await createMission(userId, input({ idempotencyKey: "persisted-strict-without-evidence" }));
  const started = await startMission(userId, legacy.id);
  await completeMissionStep(userId, legacy.id, started!.currentStepId!, "A model-authored completion claim.");
  await updateMission(userId, legacy.id, { verification: { mode: "strict", requiredEvidence: [], verified: false, unresolved: [] } });
  const verified = await verifyMission(userId, legacy.id);
  assert.equal(verified?.verification?.verified, false);
  assert.match(verified?.verification?.unresolved.join(" ") ?? "", /no required evidence criteria/i);
  assert.equal(await completeMission(userId, legacy.id, "Do not complete without evidence."), undefined);
});

test("explicit completion cannot override a pause", async () => {
  const userId = 951034;
  const mission = await createMission(userId, input({ idempotencyKey: "paused-explicit-complete", steps: [
    { id: "only", title: "Only", objective: "Complete" },
  ] }));
  const started = await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Step verified.");
  await pauseMission(userId, mission.id, "Owner paused before closeout.");
  assert.equal(await completeMission(userId, mission.id, "Do not close while paused."), undefined);
  assert.equal((await getMission(userId, mission.id))?.status, "paused");
});

test("mission replanning preserves verified steps and selects the next dependency-ready step", async () => {
  const userId = 951006;
  const mission = await createMission(userId, input({ idempotencyKey: "replan-1", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "draft", title: "Draft", objective: "Write the brief.", dependsOn: ["research"] },
  ] }));
  await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, "research", "Sources verified.");
  const replanned = await replanMission(userId, mission.id, [
    { id: "research", title: "Rewritten completed step", objective: "Replace the verified work." },
    { id: "draft", title: "Draft", objective: "Write the brief with the new positioning." , dependsOn: ["research"] },
    { id: "review", title: "Review", objective: "Check the revised brief.", dependsOn: ["draft"] },
  ], "The positioning changed after source verification.");
  assert.equal(replanned?.steps.find((step) => step.id === "research")?.status, "completed");
  assert.equal(replanned?.steps.find((step) => step.id === "research")?.title, "Research");
  assert.equal(replanned?.steps.find((step) => step.id === "research")?.objective, "Collect sources.");
  assert.equal(replanned?.steps.find((step) => step.id === "research")?.result, "Sources verified.");
  assert.equal(replanned?.steps.find((step) => step.id === "draft")?.status, "running");
  assert.equal(replanned?.currentStepId, "draft");
  assert.match(replanned?.events.at(-1)?.message ?? "", /replanned/i);
  await assert.rejects(() => replanMission(userId, mission.id, [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "draft", title: "Draft", objective: "Draft", dependsOn: ["review"] },
    { id: "review", title: "Review", objective: "Review", dependsOn: ["draft"] },
  ], "Invalid cycle"), /dependency cycle/);
});

test("mission replanning replaces stale active steps and starts every ready branch", async () => {
  const userId = 951032;
  const mission = await createMission(userId, input({ idempotencyKey: "replan-replaces-active", steps: [
    { id: "root", title: "Root", objective: "Prepare input." },
    { id: "old", title: "Old plan", objective: "Obsolete task.", dependsOn: ["root"] },
  ] }));
  await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, "root", "Root done.");
  const replanned = await replanMission(userId, mission.id, [
    { id: "root", title: "Root", objective: "Prepare input." },
    { id: "new-a", title: "New A", objective: "First branch.", dependsOn: ["root"] },
    { id: "new-b", title: "New B", objective: "Second branch.", dependsOn: ["root"] },
    { id: "join", title: "Join", objective: "Combine branches.", dependsOn: ["new-a", "new-b"] },
  ], "The work split changed.");
  assert.deepEqual(replanned?.activeStepIds, ["new-a", "new-b"]);
  assert.equal(replanned?.currentStepId, "new-a");
  assert.deepEqual(replanned?.steps.filter((step) => step.status === "running").map((step) => step.id), ["new-a", "new-b"]);
});

test("mission replanning rejects unknown dependencies without mutating existing state", async () => {
  const userId = 951033;
  const mission = await createMission(userId, input({ idempotencyKey: "replan-unknown-dependency", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
  ] }));
  await startMission(userId, mission.id);
  const before = await getMission(userId, mission.id);
  await assert.rejects(() => replanMission(userId, mission.id, [
    { id: "draft", title: "Draft", objective: "Write brief.", dependsOn: ["missing"] },
  ], "Invalid reference."), /unknown dependency/i);
  assert.deepEqual(await getMission(userId, mission.id), before);
});
