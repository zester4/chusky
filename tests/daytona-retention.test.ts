import assert from "node:assert/strict";
import test from "node:test";
import { isExpired, retentionFromSeconds, visualDiffStatus } from "../src/lib/daytona/retention.js";

test("artifact retention defaults to owner-retained and accepts bounded TTL", () => {
  assert.deepEqual(retentionFromSeconds(undefined, 1_000), { mode: "forever", policyName: "owner-retained" });
  assert.deepEqual(retentionFromSeconds(60, 1_000), { mode: "ttl", expiresAt: 61_000, policyName: "owner-requested-ttl" });
  assert.equal(isExpired({ mode: "ttl", expiresAt: 61_000 }, 61_000), true);
  assert.equal(isExpired({ mode: "forever" }, Number.MAX_SAFE_INTEGER), false);
});

test("artifact retention rejects unsafe or unbounded expiry values", () => {
  assert.throws(() => retentionFromSeconds(59));
  assert.throws(() => retentionFromSeconds(365 * 24 * 60 * 60 + 1));
});

test("visual diff history distinguishes baseline, unchanged, and changed output", () => {
  assert.equal(visualDiffStatus(undefined, "a"), "baseline");
  assert.equal(visualDiffStatus("a", "a"), "unchanged");
  assert.equal(visualDiffStatus("a", "b"), "changed");
});
