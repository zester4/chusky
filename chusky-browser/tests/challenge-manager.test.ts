import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeManager, BrowserOrchestrator, type BrowserAdapter, type BrowserObservation, type BrowserPolicy, type BrowserTask, type SessionHandle } from "../src/index.js";

const policy: BrowserPolicy = {
  allowedOrigins: ["https://example.com"],
  maxActions: 4,
  maxDurationMs: 5_000,
  noProgressLimit: 2,
  defaultScreenshot: "viewport",
  requireHandoffForChallenges: true,
};

function observation(id: string, challenge?: BrowserObservation["challenge"]): BrowserObservation {
  return {
    observationId: id,
    pageGeneration: Number(id.replace(/\D/g, "")) || 1,
    provider: "local",
    url: "https://example.com/checkout",
    title: "Example",
    origin: "https://example.com",
    frameIndex: 0,
    controls: [],
    accessibilityHash: id,
    tabCount: 1,
    capturedAt: Date.now(),
    ...(challenge ? { challenge } : {}),
  };
}

function session(): SessionHandle {
  return { id: "session-1", provider: "local", ownerScope: "owner:1", state: "ready", capabilities: new Set(["screenshots", "live-view"]) };
}

function challengeAdapter(options: { waitStatus: "cleared" | "failed" | "timeout" | "abandoned"; clearAfterWait?: boolean; initialChallenge?: boolean }): BrowserAdapter {
  let observes = 0;
  const current = session();
  return {
    id: "local",
    capabilities: current.capabilities,
    async start() { return current; },
    async observe() {
      observes += 1;
      return observation(`observe-${observes}`, (options.initialChallenge !== false && observes === 1) || !options.clearAfterWait ? { detected: true, kind: "press-and-hold", status: "waiting" } : undefined);
    },
    async act() { throw new Error("action must not run while challenge is active"); },
    async verify() { return { verified: true, checks: [] }; },
    async waitForChallenge() { return { status: options.waitStatus }; },
    async handoff() { return { status: "user-required", liveViewUrl: "https://viewer.example.test/opaque", expiresAt: Date.now() + 60_000 }; },
    async stop() {},
  };
}

test("provider solver is followed by a fresh observation before verification", async () => {
  const states: string[] = [];
  const adapter = challengeAdapter({ waitStatus: "cleared", clearAfterWait: true, initialChallenge: false });
  const manager = new ChallengeManager(adapter, { ledger: { append(event) { states.push(event.state); } } });
  const result = await manager.resolve({ session: session(), observation: observation("observe-1", { detected: true, kind: "captcha", status: "waiting" }), policy });
  assert.equal(result.status, "verified");
  assert.equal(result.outcome?.sameSession, true);
  assert.deepEqual(states, ["detected", "solver_waiting", "solved_unverified", "verified"]);
  assert.equal(result.observation?.challenge, undefined);
});

test("solver failure becomes an owner handoff and resume verifies the same session", async () => {
  const adapter = challengeAdapter({ waitStatus: "timeout", clearAfterWait: false });
  const manager = new ChallengeManager(adapter);
  const pending = await manager.resolve({ session: session(), observation: observation("observe-1", { detected: true, kind: "captcha", status: "waiting" }), policy });
  assert.equal(pending.status, "user-required");
  assert.equal(pending.outcome?.state, "handoff_required");
  assert.equal(pending.outcome?.liveViewUrl, "https://viewer.example.test/opaque");
  assert.ok(manager.history().some((event) => event.state === "timeout"));

  const resumed = await manager.resume({ session: session(), outcome: pending.outcome!, expectedOrigin: "https://example.com" });
  assert.equal(resumed.status, "user-required");

  const clearAdapter = challengeAdapter({ waitStatus: "cleared", clearAfterWait: true, initialChallenge: false });
  const resumedManager = new ChallengeManager(clearAdapter);
  const verified = await resumedManager.resume({ session: session(), outcome: pending.outcome!, expectedOrigin: "https://example.com" });
  assert.equal(verified.status, "verified");
  assert.equal(verified.outcome?.sessionId, "session-1");
});

test("orchestrator retains the exact session when a handoff is required", async () => {
  let stopped = false;
  let acted = false;
  const base = challengeAdapter({ waitStatus: "failed", clearAfterWait: false });
  const adapter: BrowserAdapter = { ...base, async act() { acted = true; throw new Error("must not run"); }, async stop() { stopped = true; } };
  const task: BrowserTask = { id: "challenge-task", ownerScope: "owner:1", startUrl: "https://example.com", actions: [{ id: "submit", kind: "click", mutation: "consequential", retry: "never", expected: [] }], approvedActionIds: ["submit"] };
  const result = await new BrowserOrchestrator(adapter).run(task);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "challenge-user-required");
  assert.equal(result.continuation?.session.id, "session-1");
  assert.equal(acted, false);
  assert.equal(stopped, false);
});
