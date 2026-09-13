import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

test("Twilio stream ticket binds an account-selected Flux voice to the call", () => {
  const callId = "twc_11111111-1111-1111-1111-111111111111";
  const voice = "flux-haley-en";
  const ticket = createVoiceBridgeTicket(callId, 42, "bridge-secret", 1_000, voice);
  const [expiresAt, signedVoice, signature] = ticket.split(".");
  assert.equal(expiresAt, "301000");
  assert.equal(signedVoice, voice);
  assert.equal(signature, createHmac("sha256", "bridge-secret").update(`${callId}.42.301000.${voice}`).digest("hex"));
  assert.throws(() => createVoiceBridgeTicket(callId, 42, "bridge-secret", 1_000, "https://attacker.invalid"), /Invalid Twilio Flux voice/);
});
