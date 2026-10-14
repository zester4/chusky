import test, { before } from "node:test";
import assert from "node:assert/strict";
import { nativeTool } from "../src/nativeTools.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { createMission, getMission, initStore, startMission, updateMission } from "../src/store.js";

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
  const args = { id: mission.id, checkpoint, nextAction };
  validateNativeToolArguments("CHUCK_MISSION_CHECKPOINT", args);
  const updated = await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", args) as { checkpoint: string; nextAction: string };

  assert.equal(updated.checkpoint, checkpoint);
  assert.equal(updated.nextAction, nextAction);
});

test("mission doctor returns owner-scoped runtime diagnosis without changing mission state", async () => {
  const userId = 951110;
  const mission = await createMission(userId, {
    title: "Diagnose stale wait",
    objective: "Find why a durable wait cannot resume.",
    definitionOfDone: "The runtime mismatch is identified without changing the mission.",
    steps: [{ id: "active", title: "Resume check", objective: "Continue after the timer" }],
  });
  await startMission(userId, mission.id);
  await updateMission(userId, mission.id, {
    status: "waiting",
    waiting: { kind: "timer", runAt: Date.now() + 60_000, stepId: "missing-step" },
  });

  const report = await nativeTool(userId, "CHUCK_MISSION_DOCTOR", { id: mission.id }) as { missionId: string; health: string; reasons: string[]; nextActions: string[] };
  assert.equal(report.missionId, mission.id);
  assert.equal(report.health, "stalled");
  assert.ok(report.reasons.includes("mission_wait_step_mismatch"));
  assert.ok(report.nextActions.some((action) => /repair the saved wait continuation/i.test(action)));
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
  await assert.rejects(nativeTool(userId + 1, "CHUCK_MISSION_DOCTOR", { id: mission.id }), /not found or not owned/);
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");
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
  const returned = await nativeTool(userId, "CHUCK_MISSION_START", args, { enqueueMissionTask: async () => "workflow-limit-test" }) as { id: string; objective: string };

  assert.equal(returned.id, existing.id);
  assert.equal(returned.objective, existing.objective);
  assert.throws(() => validateNativeToolArguments("CHUCK_MISSION_START", { ...args, objective: "O".repeat(8001) }), /objective.*8000/);
});

test("mission step tool fences are published and strip supervisor-owned tools from model plans", async () => {
  const args = {
    title: "Scoped mission",
    objective: "Run one bounded provider action.",
    definitionOfDone: "The action is verified.",
    steps: [{ title: "Send", objective: "Send the message", allowedTools: ["GMAIL_SEND_EMAIL"] }],
  };
  validateNativeToolArguments("CHUCK_MISSION_START", args);
  const returned = await nativeTool(951104, "CHUCK_MISSION_START", {
    ...args,
    steps: [{ ...args.steps[0], allowedTools: ["CHUCK_MISSION_STEP_COMPLETE"] }],
  }, { enqueueMissionTask: async () => "workflow-supervisor-tool-strip" }) as { steps: Array<{ allowedTools?: string[] }> };
  assert.deepEqual(returned.steps[0]?.allowedTools, []);
});

test("native-only three-step mission starts when the model repeats supervisor controls in every fence", async () => {
  const supervisorTools = [
    "CHUCK_TASK_WAIT",
    "CHUCK_MISSION_GET",
    "CHUCK_MISSION_CHECKPOINT",
    "CHUCK_MISSION_STEP_COMPLETE",
    "CHUCK_MISSION_EVIDENCE",
    "CHUCK_MISSION_VERIFY",
    "CHUCK_MISSION_COMPLETE",
  ];
  const returned = await nativeTool(951105, "CHUCK_MISSION_START", {
    title: "Native-only mission reliability test",
    objective: "Complete a durable three-step internal lifecycle test.",
    definitionOfDone: "All three steps complete after one durable wait and persisted evidence.",
    verificationMode: "legacy",
    steps: [1, 2, 3].map((number) => ({
      title: `Step ${number}`,
      objective: `Complete internal step ${number}.`,
      allowedTools: supervisorTools,
    })),
  }, { enqueueMissionTask: async () => "workflow-native-three-step-strip" }) as { steps: Array<{ allowedTools?: string[] }> };
  assert.equal(returned.steps.length, 3);
  for (const step of returned.steps) assert.deepEqual(step.allowedTools, []);
});

test("mission block accepts verbose recovery diagnostics and persists a bounded reason", async () => {
  const userId = 951102;
  const mission = await createMission(userId, {
    title: "Verbose recovery mission",
    objective: "Exercise the mission blocker boundary.",
    definitionOfDone: "A blocked mission records a usable recovery path.",
  });
  await startMission(userId, mission.id);

  const args = {
    id: mission.id,
    reason: `Provider verification failed after a recoverable execution boundary. ${"diagnostic detail ".repeat(300)}`,
    nextAction: "Inspect the persisted provider receipt and resume this same mission.",
  };
  validateNativeToolArguments("CHUCK_MISSION_BLOCK", args);
  const blocked = await nativeTool(userId, "CHUCK_MISSION_BLOCK", args) as { status: string; error?: string };

  assert.equal(blocked.status, "blocked");
  assert.ok((blocked.error?.length ?? 0) <= 2000);
  assert.match(blocked.error ?? "", /Provider verification failed/);
});
