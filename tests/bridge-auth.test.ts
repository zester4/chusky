import test from "node:test";
import assert from "node:assert/strict";
import { hasBridgeAuthorization } from "../src/calls/bridgeAuth.js";

test("FaceTime bridge authentication is strict", () => {
  assert.equal(hasBridgeAuthorization("Bearer bridge-secret", "bridge-secret"), true);
  assert.equal(hasBridgeAuthorization("Bearer wrong", "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization("Basic bridge-secret", "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization(undefined, "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization("Bearer bridge-secret", ""), false);
});
