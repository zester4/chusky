import assert from "node:assert/strict";
import test from "node:test";
import { initialChallengeResolution, normalizeChallengeProvider, normalizeChallengeType, transitionChallengeState } from "../src/vault/challengeResolution.js";

test("challenge resolution defaults E2B to an owner handoff", () => {
  assert.deepEqual(initialChallengeResolution("e2b"), { provider: "e2b", state: "handoff_required", automatic: false, requiresOwner: true });
  assert.deepEqual(initialChallengeResolution("browserbase", true), { provider: "browserbase", state: "detected", automatic: true, requiresOwner: false });
});

test("provider challenge transitions never treat detection as verification", () => {
  assert.equal(transitionChallengeState("detected", "provider_solving_started"), "solving");
  assert.equal(transitionChallengeState("solving", "provider_solving_finished"), "solved_unverified");
  assert.equal(transitionChallengeState("solved_unverified", "verification_passed"), "verified");
  assert.throws(() => transitionChallengeState("detected", "provider_solving_finished"), /Cannot finish provider solving/);
  assert.equal(transitionChallengeState("verified", "detected"), "verified");
});

test("challenge metadata normalizes unknown provider and type safely", () => {
  assert.equal(normalizeChallengeProvider("unknown-provider"), "e2b");
  assert.equal(normalizeChallengeType("unknown-challenge"), "site_challenge");
  assert.equal(normalizeChallengeType("captcha"), "captcha");
});
