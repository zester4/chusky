import test, { before } from "node:test";
import assert from "node:assert/strict";
import { nativeTool } from "../src/nativeTools.js";
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
