import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expireMissionProofKeys, missionProofRedisKeys, runMissionProcess } from "./helpers/missionProcessHarness.js";

after(expireMissionProofKeys);

test("real Redis coordinator completes with physically isolated keys", { timeout: 120000 }, async () => {
  assert.ok(process.env.MISSION_PROCESS_REDIS_URL, "Explicitly supply the user-authorized Redis connection.");
  const proof = await runMissionProcess({ mode: "run", now: Date.UTC(2026, 0, 1), userId: randomInt(900000000, 999000000) });
  assert.equal(proof.result?.missionStatus, "completed");
  assert.equal(proof.result?.taskStatus, "completed");
  assert.ok(missionProofRedisKeys.size > 0, "This must exercise the real Redis backend, not memory fallback.");
});

test("real Redis recovers a killed leased worker without changing task identity", { timeout: 120000 }, async () => {
  const now = Date.UTC(2026, 0, 1);
  const baseline = await runMissionProcess({ mode: "run", now, userId: randomInt(900000000, 999000000) });
  const boundary = baseline.boundaries.find((entry) => entry.startsWith("src/taskSlice.ts:") && entry.endsWith(":before"));
  assert.ok(boundary);
  const prepared = await runMissionProcess({ mode: "prepare", now, userId: randomInt(900000000, 999000000) });
  const fixture = prepared.result!.fixture;
  const killed = await runMissionProcess({ mode: "run", now, fixture }, boundary);
  assert.equal(killed.killed, true);
  await delay(1100);
  const recovered = await runMissionProcess({ mode: "recover", now: now + 600000, fixture });
  assert.deepEqual(recovered.result?.fixture, fixture);
  assert.equal(recovered.result?.missionStatus, "completed");
  assert.equal(recovered.result?.taskStatus, "completed");
});
