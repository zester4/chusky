import test from "node:test";
import assert from "node:assert/strict";
import { createMission, getMission, initStore, repairMission, updateMission } from "../src/store.js";

test("owner repair clears an inconsistent durable wait and keeps resume explicit", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990042;
  const mission = await createMission(userId, {
    title: "Recover timer continuation",
    objective: "Resume from the active step after repairing a stale wait.",
    definitionOfDone: "The owner explicitly resumes the repaired mission.",
    steps: [{ id: "step-1", title: "Active step", objective: "Continue work" }],
  });
  await updateMission(userId, mission.id, {
    status: "waiting",
    waiting: { kind: "timer", runAt: Date.now() + 60_000, stepId: "missing-step" },
  });

  const repaired = await repairMission(userId, mission.id, {
    reason: "The saved timer continuation points to a missing step.",
    nextAction: "Review the active step, then resume explicitly.",
  });

  assert.equal(repaired?.status, "blocked");
  assert.equal(repaired?.waiting, undefined);
  assert.equal(repaired?.nextAction, "Review the active step, then resume explicitly.");
  assert.ok(repaired?.events.some((event) => event.type === "repaired"));
  assert.equal((await getMission(userId, mission.id))?.waiting, undefined);
});
