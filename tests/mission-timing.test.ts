import test, { before } from "node:test";
import assert from "node:assert/strict";
import { initStore, createMission, startMission, acquireMissionLease, releaseMissionLease, pauseMission, resumeMission, missionBudgetPreflight, getMission, completeMissionStep, extendMissionDurationIfEligible, recordTrustedMissionEvidence, waitMission, resumeMissionFromProviderEvent, renewMissionLease, recordMissionSlice } from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("active execution budget excludes queued and owner-paused time across resume", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961001, { title: "Timing", objective: "Verify timing", definitionOfDone: "Verified", budget: { maxDurationSeconds: 300 } });
  await startMission(961001, mission.id);
  now += 3_600_000;
  assert.equal(missionBudgetPreflight((await getMission(961001, mission.id))!).remaining.durationSeconds, 300);
  const leased = await acquireMissionLease(961001, mission.id, "worker", 300_000);
  now += 120_000;
  await pauseMission(961001, mission.id);
  now += 3_600_000;
  await releaseMissionLease(961001, mission.id, leased!.lease!.token);
  const resumed = await resumeMission(961001, mission.id);
  assert.equal(resumed?.status, "running");
  assert.equal(missionBudgetPreflight(resumed!).remaining.durationSeconds, 180);
});

test("overall deadline expires even when active execution is paused", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961002, { title: "Deadline", objective: "Check lifetime", definitionOfDone: "Verified", budget: { maxDurationSeconds: 300, maxLifetimeSeconds: 600 } });
  await startMission(961002, mission.id);
  await pauseMission(961002, mission.id);
  now += 601_000;
  const resumed = await resumeMission(961002, mission.id);
  assert.equal(resumed?.status, "blocked");
  assert.match(resumed?.error ?? "", /overall deadline/);
});

test("automatic extensions require new completed progress and never change other budgets", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961003, { title: "Extension", objective: "Finish bounded work", definitionOfDone: "Verified", budget: { maxDurationSeconds: 60, automaticExtensionSeconds: 60, maxAutomaticExtensions: 2 }, steps: [
    { id: "a", title: "A", objective: "Finish A" }, { id: "b", title: "B", objective: "Finish B", dependsOn: ["a"] }, { id: "c", title: "C", objective: "Finish C", dependsOn: ["b"] },
  ] });
  await startMission(961003, mission.id);
  const lease = await acquireMissionLease(961003, mission.id, "worker", 300_000);
  await recordTrustedMissionEvidence(961003, mission.id, [{ id: "receipt-a", kind: "tool_receipt", summary: "A confirmed", verified: true, verifiedBy: "system", verifiedAt: now }], "a");
  await completeMissionStep(961003, mission.id, "a", "Verified progress");
  now += 61_000;
  await releaseMissionLease(961003, mission.id, lease!.lease!.token);
  const extended = await extendMissionDurationIfEligible(961003, mission.id);
  assert.equal(extended?.budget.maxDurationSeconds, 120);
  assert.equal(extended?.timing?.extensionsUsed, 1);
  assert.equal(extended?.budget.maxCost, mission.budget.maxCost);
  assert.equal(extended?.budget.maxToolCalls, mission.budget.maxToolCalls);
  assert.equal(extended?.budget.maxSteps, mission.budget.maxSteps);
  const secondLease = await acquireMissionLease(961003, mission.id, "worker", 300_000);
  now += 61_000;
  await releaseMissionLease(961003, mission.id, secondLease!.lease!.token);
  assert.equal((await extendMissionDurationIfEligible(961003, mission.id))?.budget.maxDurationSeconds, 120);
  await recordTrustedMissionEvidence(961003, mission.id, [{ id: "receipt-b", kind: "tool_receipt", summary: "B confirmed", verified: true, verifiedBy: "system", verifiedAt: now }], "b");
  await completeMissionStep(961003, mission.id, "b", "New verified progress");
  assert.equal((await extendMissionDurationIfEligible(961003, mission.id))?.budget.maxDurationSeconds, 180);
  assert.equal(await extendMissionDurationIfEligible(961004, mission.id), undefined);
});

test("provider wait freezes active time and an expired worker lease is never renewed", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961005, { title: "Wait", objective: "Wait for receipt", definitionOfDone: "Receipt checked", budget: { maxDurationSeconds: 300 } });
  await startMission(961005, mission.id);
  const lease = await acquireMissionLease(961005, mission.id, "worker", 60_000);
  now += 20_000;
  await waitMission(961005, mission.id, { kind: "provider_event", provider: "test", providerEventId: "event1" });
  now += 120_000;
  assert.equal(await renewMissionLease(961005, mission.id, lease!.lease!.token), undefined);
  const resumed = await resumeMissionFromProviderEvent(961005, mission.id, "test", "event1");
  assert.equal(missionBudgetPreflight(resumed!).remaining.durationSeconds, 280);
  await releaseMissionLease(961005, mission.id, lease!.lease!.token);
  assert.equal(missionBudgetPreflight((await getMission(961005, mission.id))!).remaining.durationSeconds, 280);
});

test("lease loss charges only its execution window and retries cannot reset time", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961006, { title: "Lease", objective: "Recover crash", definitionOfDone: "Verified", budget: { maxDurationSeconds: 300 } });
  await startMission(961006, mission.id);
  const first = await acquireMissionLease(961006, mission.id, "worker1", 60_000);
  now += 3_600_000;
  const second = await acquireMissionLease(961006, mission.id, "worker2", 60_000);
  assert.equal(missionBudgetPreflight(second!).remaining.durationSeconds, 240);
  assert.equal(await releaseMissionLease(961006, mission.id, first!.lease!.token), undefined);
  now += 20_000;
  await releaseMissionLease(961006, mission.id, second!.lease!.token);
  assert.equal(missionBudgetPreflight((await getMission(961006, mission.id))!).remaining.durationSeconds, 220);
});

test("slice settlement consumes an authorized extension and stops once its cap is used", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961007, { title: "Cap", objective: "Bounded extension", definitionOfDone: "Verified", budget: { maxDurationSeconds: 60, automaticExtensionSeconds: 60, maxAutomaticExtensions: 1 }, steps: [
    { id: "a", title: "A", objective: "A" }, { id: "b", title: "B", objective: "B", dependsOn: ["a"] },
  ] });
  await startMission(961007, mission.id);
  await recordTrustedMissionEvidence(961007, mission.id, [{ id: "trusted-a", kind: "tool_receipt", summary: "Confirmed", verified: true, verifiedBy: "system", verifiedAt: now }], "a");
  await completeMissionStep(961007, mission.id, "a", "Done");
  const lease = await acquireMissionLease(961007, mission.id, "worker", 300_000);
  now += 61_000;
  await releaseMissionLease(961007, mission.id, lease!.lease!.token);
  const extended = await recordMissionSlice(961007, mission.id, { toolCalls: 2, cost: 0.1 });
  assert.equal(extended?.status, "running");
  assert.equal(extended?.timing?.extensionsUsed, 1);
  assert.equal(extended?.toolCalls, 2);
  const next = await acquireMissionLease(961007, mission.id, "worker", 300_000);
  now += 61_000;
  await releaseMissionLease(961007, mission.id, next!.lease!.token);
  assert.equal((await recordMissionSlice(961007, mission.id, {}))?.status, "blocked");
});

test("completed steps without trusted evidence cannot unlock more execution time", async (t) => {
  let now = 1_790_000_000_000;
  t.mock.method(Date, "now", () => now);
  const mission = await createMission(961008, { title: "No proof", objective: "Require proof", definitionOfDone: "Verified", budget: { maxDurationSeconds: 60, automaticExtensionSeconds: 60, maxAutomaticExtensions: 2 }, steps: [
    { id: "a", title: "A", objective: "A" }, { id: "b", title: "B", objective: "B", dependsOn: ["a"] },
  ] });
  await startMission(961008, mission.id);
  await completeMissionStep(961008, mission.id, "a", "Agent asserts progress");
  const lease = await acquireMissionLease(961008, mission.id, "worker", 120_000);
  now += 61_000;
  await releaseMissionLease(961008, mission.id, lease!.lease!.token);
  const result = await recordMissionSlice(961008, mission.id, {});
  assert.equal(result?.status, "blocked");
  assert.equal(result?.budget.maxDurationSeconds, 60);
  assert.equal(result?.timing?.extensionsUsed, 0);
});
