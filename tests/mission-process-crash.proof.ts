import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expireMissionProofKeys, runMissionProcess, type ProcessScenario } from "./helpers/missionProcessHarness.js";

after(expireMissionProofKeys);

for (const scenario of ["complete", "strict", "timer", "provider", "approval", "checkpoint", "failure", "prose", "cancel", "replan"] as ProcessScenario[]) test(`every ${scenario} production await survives a real process kill and same-identity restart`, { timeout: 600000 }, async () => {
  assert.ok(process.env.MISSION_PROCESS_REDIS_URL, "Set an isolated MISSION_PROCESS_REDIS_URL; never reuse production Redis for crash proofs.");
  const now = Date.UTC(2026, 0, 1);
  const baseline = await runMissionProcess({ mode: "run", now, scenario, userId: randomInt(900000000, 999000000) });
  const target = scenario === "cancel" ? "cancelled" : "completed";
  if (["complete", "strict", "cancel"].includes(scenario)) assert.equal(baseline.result?.missionStatus, target);
  const boundaries = [...new Set(baseline.boundaries)];
  assert.ok(boundaries.length > 20, "The crash matrix must exercise the real worker path.");
  const defects: string[] = [];
  for (let offset = 0; offset < boundaries.length; offset += 4) {
    await Promise.all(boundaries.slice(offset, offset + 4).map(async (boundary) => {
      const prepared = await runMissionProcess({ mode: "prepare", now, scenario, userId: randomInt(900000000, 999000000) });
      const fixture = prepared.result!.fixture;
      const crashed = await runMissionProcess({ mode: "run", now, fixture }, boundary);
      assert.equal(crashed.killed, true, `The crash boundary was not reached: ${boundary}`);
      await delay(1100); // The synthetic account lock expires in real Redis time.
      const recovered = await runMissionProcess({ mode: "recover", now: now + 600000, fixture });
      if (recovered.result?.missionStatus !== target || recovered.result?.taskStatus !== target) defects.push(boundary);
      assert.deepEqual(recovered.result?.fixture, fixture, "Recovery must retain mission and task identity.");
    }));
  }
  assert.deepEqual(defects, [], `Unrecovered process crash boundaries: ${defects.join(", ")}`);
});
