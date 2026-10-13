import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAdapter, BrowserObservation, BrowserTask, SessionHandle } from "../src/index.js";
import { BrowserOrchestrator, createActionId, defaultBrowserPolicy, planObservation, structuralFingerprint } from "../src/index.js";

function observation(id: string, generation: number, overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    observationId: id,
    pageGeneration: generation,
    provider: "local",
    url: "https://example.com/",
    title: "Example",
    origin: "https://example.com",
    frameIndex: 0,
    controls: [{ observationId: id, pageGeneration: generation, role: "button", name: "Continue", index: 0, visible: true, enabled: true }],
    accessibilityHash: `a11y-${generation}`,
    tabCount: 1,
    capturedAt: Date.now(),
    ...overrides,
  };
}

function adapter(options: { fail?: Error; challenge?: boolean } = {}): BrowserAdapter {
  let counter = 0;
  const session: SessionHandle = { id: "s1", provider: "local", ownerScope: "owner:1", state: "ready", capabilities: new Set(["structured-observation", "screenshots", "live-view"]) };
  return {
    id: "local",
    capabilities: session.capabilities,
    async start() { return session; },
    async observe(_session, request) { counter += 1; return observation(`o${counter}`, counter, { challenge: options.challenge && counter === 1 ? { detected: true, kind: "press-and-hold", status: "waiting", userRequired: false } : undefined, screenshot: request.screenshot === "none" ? undefined : { mode: request.screenshot, hash: `shot-${counter}`, width: 320, height: 180, capturedAt: Date.now(), reason: request.screenshotReason, redacted: true } }); },
    async act(_session, action) { if (options.fail) throw options.fail; return { actionId: action.id, mutationObserved: "completed" }; },
    async verify() { return { verified: true, checks: [] }; },
    async waitForChallenge(_session) { return { status: "cleared", observation: observation("challenge-clear", 2) }; },
    async stop() {},
  };
}

test("observation planning keeps the structured path fast and escalates visual evidence only for ambiguity", () => {
  assert.equal(planObservation(undefined, "initial").screenshot, "thumbnail");
  assert.equal(planObservation(undefined, "ambiguous").screenshot, "viewport");
  assert.equal(planObservation(undefined, "challenge").screenshotReason, "challenge");
});

test("structural fingerprints exclude observation-scoped and screenshot values", () => {
  const first = observation("o1", 1, { screenshot: { mode: "thumbnail", hash: "one", width: 1, height: 1, capturedAt: 1, reason: "initial", redacted: true } });
  const second = { ...first, observationId: "o2", controls: first.controls.map((control) => ({ ...control, observationId: "o2", nodeId: "different" })), screenshot: { ...first.screenshot!, hash: "two" } };
  assert.equal(structuralFingerprint(first), structuralFingerprint(second));
});

test("orchestrator verifies a bounded task and cleans up the session", async () => {
  let stopped = false;
  const base = adapter();
  const wrapped = { ...base, async stop(session: SessionHandle) { stopped = true; await base.stop(session); } } satisfies BrowserAdapter;
  const task: BrowserTask = { id: "task-1", ownerScope: "owner:1", startUrl: "https://example.com", actions: [{ id: createActionId(), kind: "click", mutation: "read-only", retry: "reobserve-only", expected: [] }] };
  const result = await new BrowserOrchestrator(wrapped).run(task);
  assert.equal(result.status, "completed");
  assert.equal(result.verified, true);
  assert.equal(stopped, true);
});

test("challenge is waited on in the same session before the action continues", async () => {
  const task: BrowserTask = { id: "challenge-task", ownerScope: "owner:1", startUrl: "https://example.com", actions: [{ id: "click-1", kind: "click", mutation: "read-only", retry: "reobserve-only", expected: [] }] };
  const result = await new BrowserOrchestrator(adapter({ challenge: true })).run(task);
  assert.equal(result.status, "completed");
  assert.ok(result.events.some((event) => event.phase === "handoff" && event.status === "waiting"));
});

test("consequential failures stop for reconciliation instead of replaying the mutation", async () => {
  const task: BrowserTask = { id: "write-task", ownerScope: "owner:1", startUrl: "https://example.com", approvedActionIds: ["submit-1"], actions: [{ id: "submit-1", kind: "click", mutation: "consequential", retry: "never", expected: [] }] };
  const result = await new BrowserOrchestrator(adapter({ fail: new Error("provider returned an unknown mutation result") })).run(task);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "reconcile");
  assert.equal(result.completedActions.length, 0);
});

test("a retryable stale action is re-observed and retried once before advancing", async () => {
  let calls = 0;
  const base = adapter();
  const wrapped = {
    ...base,
    async act(session: SessionHandle, action: BrowserTask["actions"][number]) {
      calls += 1;
      if (calls === 1) throw new Error("stale observation");
      return base.act(session, action);
    },
  } satisfies BrowserAdapter;
  const task: BrowserTask = { id: "retry-task", ownerScope: "owner:1", startUrl: "https://example.com", actions: [{ id: "click-1", kind: "click", mutation: "read-only", retry: "reobserve-and-retry", expected: [] }] };
  const result = await new BrowserOrchestrator(wrapped).run(task);
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
});

test("default policy keeps consequential workflows bounded", () => {
  const policy = defaultBrowserPolicy();
  assert.equal(policy.maxActions, 24);
  assert.equal(policy.requireHandoffForChallenges, true);
});

test("approval is an input to the task contract, never inferred from a page control", async () => {
  const task: BrowserTask = { id: "approval-task", ownerScope: "owner:1", startUrl: "https://example.com", actions: [{ id: "pay-1", kind: "click", mutation: "consequential", retry: "never", expected: [] }] };
  const result = await new BrowserOrchestrator(adapter()).run(task);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "approval-required");
  assert.equal(result.completedActions.length, 0);
});
