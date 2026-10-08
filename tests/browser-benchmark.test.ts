import test from "node:test";
import assert from "node:assert/strict";
import { browserBenchmarkManifest, scoreBrowserBenchmark } from "../src/lib/e2b/benchmark.js";

test("browser benchmark counts missing evidence as unverified", () => {
  const score = scoreBrowserBenchmark([
    { id: "form-native-controls", status: "verified", evidence: "local fixture" },
    { id: "challenge-handoff", status: "blocked", evidence: "owner challenge" },
  ]);
  assert.equal(score.total, 10);
  assert.equal(score.verified, 1);
  assert.equal(score.blocked, 1);
  assert.equal(score.unverified, 8);
  assert.equal(score.scorePercent, 10);
  assert.equal(score.targetMet, false);
});

test("browser benchmark reports tag-level readiness and the 75 percent gate", () => {
  const manifest = browserBenchmarkManifest();
  const score = scoreBrowserBenchmark(manifest.map((item) => ({ id: item.id, status: "verified" as const })), 75);
  assert.equal(score.scorePercent, 100);
  assert.equal(score.targetMet, true);
  assert.equal(score.byTag.form.scorePercent, 100);
  assert.equal(score.byTag.handoff.scorePercent, 100);
});

test("browser benchmark rejects duplicate and unknown evidence", () => {
  assert.throws(() => scoreBrowserBenchmark([
    { id: "form-native-controls", status: "verified" },
    { id: "form-native-controls", status: "failed" },
  ]), /Duplicate/);
  assert.throws(() => scoreBrowserBenchmark([{ id: "not-a-case", status: "verified" }]), /Unknown/);
  assert.throws(() => scoreBrowserBenchmark([], 101), /between 0 and 100/);
});
