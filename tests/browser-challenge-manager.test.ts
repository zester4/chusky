import assert from "node:assert/strict";
import test from "node:test";
import { BrowserChallengeManager } from "../src/lib/browser-runtime/challenge.js";

test("browser challenge manager normalizes dedicated runtime challenges without exposing provider URLs", () => {
  const manager = new BrowserChallengeManager();
  const challenge = manager.detect({ provider: "dedicated", sessionId: "runtime-session", needsUserInteraction: true, observedUrl: "https://shop.example/checkout", challenge: { detected: true, type: "press_and_hold", terminalStatus: "timeout" } });
  assert.equal(challenge?.provider, "playwright");
  assert.equal(challenge?.type, "site_challenge");
  assert.equal(challenge?.solverOutcome, "timeout");
  assert.equal(challenge?.sessionId, "runtime-session");
});

test("browser challenge manager creates one owner handoff on the retained session", async () => {
  const manager = new BrowserChallengeManager();
  const result = await manager.handoff({
    result: { provider: "kernel", sessionId: "br_123", needsUserInteraction: true, observedUrl: "https://shop.example/checkout", challenge: { detected: true, type: "captcha", terminalStatus: "failure" } },
    createHandoff: async (challenge) => ({ handoffId: "bh_123", sessionId: challenge.sessionId, private: true }),
  });
  assert.equal(result.challenge?.solverOutcome, "failed");
  assert.equal(result.result.challengeResolution && (result.result.challengeResolution as { sameSession?: boolean }).sameSession, true);
  assert.equal((result.result.browserHandoff as { handoffId: string }).handoffId, "bh_123");
  assert.equal((result.result.browserHandoff as { sessionId: string }).sessionId, "br_123");
});
