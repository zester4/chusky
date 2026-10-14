import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalSdkFingerprint } from "../src/sdkIdentity.js";

test("legacy request fingerprints migrate without changing replay comparisons", () => {
  const legacy = 'POST:/v1/reminders:{"text":"test"}';
  const digest = createHash("sha256").update(legacy).digest("hex");
  assert.equal(canonicalSdkFingerprint(legacy), digest);
  assert.equal(canonicalSdkFingerprint(digest), digest);
  assert.notEqual(canonicalSdkFingerprint(`${legacy} `), digest);
});
