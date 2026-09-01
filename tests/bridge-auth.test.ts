import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceBridgeTicket, hasBridgeAuthorization } from "../src/calls/bridgeAuth.js";

test("FaceTime bridge authentication is strict", () => {
  assert.equal(hasBridgeAuthorization("Bearer bridge-secret", "bridge-secret"), true);
  assert.equal(hasBridgeAuthorization("Bearer wrong", "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization("Basic bridge-secret", "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization(undefined, "bridge-secret"), false);
  assert.equal(hasBridgeAuthorization("Bearer bridge-secret", ""), false);
});

test("Twilio stream ticket is short-lived and does not contain the bridge secret", () => {
  const ticket = createVoiceBridgeTicket("twc_11111111-1111-1111-1111-111111111111", 42, "bridge-secret", 1_000);
  assert.match(ticket, /^301000\.[a-f0-9]{64}$/);
  assert.equal(ticket.includes("bridge-secret"), false);
});
