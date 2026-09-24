import test, { before } from "node:test";
import assert from "node:assert/strict";
import { nativeTool } from "../src/nativeTools.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { createMission, initStore, startMission } from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("mission native tools honor their published long-text limits", async () => {
  const userId = 951100;
  const mission = await createMission(userId, {
    title: "Long checkpoint mission",
    objective: "Preserve a detailed verified checkpoint.",
    definitionOfDone: "The checkpoint is stored without a generic text-limit failure.",
  });
  await startMission(userId, mission.id);

  const checkpoint = "c".repeat(7_500);
  const nextAction = "n".repeat(1_800);
  const updated = await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", { id: mission.id, checkpoint, nextAction }) as { checkpoint: string; nextAction: string };

  assert.equal(updated.checkpoint, checkpoint);
  assert.equal(updated.nextAction, nextAction);
});

test("mission start accepts its published objective and step text limits", async () => {
  const userId = 951101;
  const idempotencyKey = "long-mission-input";
  const existing = await createMission(userId, {
    title: "Existing mission",
    objective: "Already created",
    definitionOfDone: "The original mission remains unchanged.",
    idempotencyKey,
  });
  await startMission(userId, existing.id);

  const args = {
    title: "T".repeat(240),
    objective: "O".repeat(5000),
    definitionOfDone: "D".repeat(2000),
    idempotencyKey,
    steps: [{ title: "S".repeat(240), objective: "X".repeat(3000) }],
  };
  validateNativeToolArguments("CHUCK_MISSION_START", args);
  const returned = await nativeTool(userId, "CHUCK_MISSION_START", args) as { id: string; objective: string };

  assert.equal(returned.id, existing.id);
  assert.equal(returned.objective, existing.objective);
  assert.throws(() => validateNativeToolArguments("CHUCK_MISSION_START", { ...args, objective: "O".repeat(8001) }), /objective.*8000/);
});
