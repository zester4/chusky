import test from "node:test";
import assert from "node:assert/strict";
import { runMissionProcess, type ProcessScenario } from "./helpers/missionProcessHarness.js";

let baseline: ReturnType<typeof runMissionProcess> | undefined;
const inspectBaseline = () => baseline ??= runMissionProcess({ mode: "run", now: Date.UTC(2026, 0, 1), userId: 983001, memoryOnly: true });

test("process crash harness records real production awaits without adding runtime test hooks", async () => {
  const proof = await inspectBaseline();
  assert.equal(proof.result?.missionStatus, "completed");
  assert.equal(proof.result?.taskStatus, "completed");
  for (const module of ["src/taskRunner.ts", "src/taskSlice.ts", "src/missionSlice.ts", "src/store.ts"]) {
    assert.ok(proof.boundaries.some((boundary) => boundary.startsWith(module)), `The live ${module} path was not instrumented.`);
  }
  assert.ok(proof.boundaries.some((boundary) => boundary.endsWith(":before")));
  assert.ok(proof.boundaries.some((boundary) => boundary.endsWith(":after")));
});

test("crash fixtures exercise each coordinator branch without mistaking scripted outcomes for live-provider proof", async () => {
  const scenarios: ProcessScenario[] = ["strict", "timer", "provider", "approval", "checkpoint", "failure", "prose", "cancel", "replan"];
  for (let offset = 0; offset < scenarios.length; offset += 3) {
    await Promise.all(scenarios.slice(offset, offset + 3).map(async (scenario, index) => {
      const proof = await runMissionProcess({ mode: "run", now: Date.UTC(2026, 0, 1), userId: 983010 + offset + index, memoryOnly: true, scenario });
      assert.ok(proof.result, `${scenario} must reach persisted settlement, not fail in fixture setup`);
      assert.ok(proof.boundaries.some((boundary) => boundary.startsWith("src/taskSlice.ts:")), `${scenario} must execute the production coordinator`);
      if (scenario === "strict") assert.equal(proof.result.missionStatus, "completed");
      if (scenario === "cancel") assert.equal(proof.result.missionStatus, "cancelled");
      if (scenario === "prose") assert.notEqual(proof.result.missionStatus, "completed");
    }));
  }
});

test("the await probe kills the worker process rather than running its finally cleanup", async () => {
  const proof = await inspectBaseline();
  const boundary = proof.boundaries.find((entry) => entry.startsWith("src/taskSlice.ts:") && entry.endsWith(":before"));
  assert.ok(boundary);
  const killed = await runMissionProcess({ mode: "run", now: Date.UTC(2026, 0, 1), userId: 983002, memoryOnly: true }, boundary);
  assert.equal(killed.killed, true);
  assert.equal(killed.result, undefined, "A killed worker cannot report a finally-driven successful closeout.");
  assert.equal(killed.boundaries.at(-1), boundary);
});
