import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLiveMissionSmokeDelays, verifyLiveMissionSmokeSecret } from "../src/reliability/liveMissionSmoke.js";

test("staging mission smoke uses three bounded production-sized waits", () => {
  assert.deepEqual(normalizeLiveMissionSmokeDelays(undefined), [60, 60, 60]);
  assert.deepEqual(normalizeLiveMissionSmokeDelays([60, 90, 120]), [60, 90, 120]);
  assert.throws(() => normalizeLiveMissionSmokeDelays([1, 60, 60]), /whole number from/);
  assert.throws(() => normalizeLiveMissionSmokeDelays([60, 60]), /Exactly three/);
  assert.throws(() => normalizeLiveMissionSmokeDelays([60, 60, 3601]), /whole number from/);
});

test("staging mission smoke secret comparison fails closed and is timing-safe", () => {
  assert.equal(verifyLiveMissionSmokeSecret("secret", "secret"), true);
  assert.equal(verifyLiveMissionSmokeSecret("secret", "SECRET"), false);
  assert.equal(verifyLiveMissionSmokeSecret("secret", "secret-longer"), false);
  assert.equal(verifyLiveMissionSmokeSecret(undefined, "secret"), false);
  assert.equal(verifyLiveMissionSmokeSecret("secret", undefined), false);
});
