import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointMission,
  cancelMission,
  completeMissionStep,
  completeMission,
  createMission,
  finalizeMissionIfReady,
  getMission,
  initStore,
  pauseMission,
  recordMissionSlice,
  replanMission,
  resumeMissionFromProviderEvent,
  resumeMission,
  startMission,
  updateMission,
  verifyMission,
  waitMission,
  type MissionRecord,
} from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

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

  const done = await completeMission(userId, created.id, "Verified launch brief is ready.");
  assert.equal(done?.status, "completed");
  assert.equal(done?.result, "Verified launch brief is ready.");
  assert.equal((await completeMission(userId, created.id, "duplicate")), undefined);
});

test("mission idempotency returns the original mission instead of starting duplicate work", async () => {
  const userId = 951002;
  const first = await createMission(userId, input({ idempotencyKey: "same-request" }));
  const second = await createMission(userId, input({ idempotencyKey: "same-request", title: "A different title" }));
  assert.equal(second.id, first.id);
  assert.equal(second.title, first.title);
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

test("mission replanning preserves verified steps and selects the next dependency-ready step", async () => {
  const userId = 951006;
  const mission = await createMission(userId, input({ idempotencyKey: "replan-1", steps: [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "draft", title: "Draft", objective: "Write the brief.", dependsOn: ["research"] },
  ] }));
  await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, "research", "Sources verified.");
  const replanned = await replanMission(userId, mission.id, [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "draft", title: "Draft", objective: "Write the brief with the new positioning." , dependsOn: ["research"] },
    { id: "review", title: "Review", objective: "Check the revised brief.", dependsOn: ["draft"] },
  ], "The positioning changed after source verification.");
  assert.equal(replanned?.steps.find((step) => step.id === "research")?.status, "completed");
  assert.equal(replanned?.steps.find((step) => step.id === "draft")?.status, "running");
  assert.equal(replanned?.currentStepId, "draft");
  assert.match(replanned?.events.at(-1)?.message ?? "", /replanned/i);
  await assert.rejects(() => replanMission(userId, mission.id, [
    { id: "research", title: "Research", objective: "Collect sources." },
    { id: "draft", title: "Draft", objective: "Draft", dependsOn: ["review"] },
    { id: "review", title: "Review", objective: "Review", dependsOn: ["draft"] },
  ], "Invalid cycle"), /dependency cycle/);
});
