import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLEX_BROWSER_CASES,
  ProviderCircuitBreaker,
  TargetRegistry,
  chooseVisualCapture,
  evaluateBenchmarkCase,
  rankRoutes,
  recordVisualCapture,
  scoreBenchmark,
} from "../src/index.js";

test("routes by capabilities and workload instead of provider-name branches", () => {
  const routes = rankRoutes(
    { workload: "challenge", requiredCapabilities: ["live-view"] },
    [
      { id: "playwright-cdp", capabilities: new Set(["structured-observation"]), healthy: true },
      { id: "kernel", capabilities: new Set(["live-view", "native-input", "profiles"]), healthy: true, latencyMs: 200 },
      { id: "e2b", capabilities: new Set(["live-view", "screenshots"]), healthy: true },
    ],
  );
  assert.equal(routes[0]?.provider, "kernel");
  assert.equal(routes[0]?.controlPlane, "handoff");
  assert.equal(routes.some((route) => route.provider === "playwright-cdp"), false);
});

test("target registry recovers focus after a popup and invalidates navigation generation", () => {
  const registry = new TargetRegistry();
  registry.apply({ type: "attached", target: { id: "main", kind: "page", url: "https://example.com", title: "Main" }, at: 1 });
  registry.apply({ type: "attached", target: { id: "frame", kind: "iframe", parentId: "main", url: "https://example.com/frame", title: "Frame" }, at: 2 });
  registry.apply({ type: "focused", id: "frame", at: 3 });
  registry.apply({ type: "navigated", id: "frame", url: "https://example.com/frame-2", at: 4 });
  assert.equal(registry.resolveFocus()?.pageGeneration, 1);
  registry.apply({ type: "detached", id: "frame", at: 5 });
  assert.equal(registry.resolveFocus()?.id, "main");
});

test("visual evidence stays cheap until ambiguity or proof requires escalation", () => {
  const budget = { maxCaptures: 2, maxBytes: 20_000, captures: 0, bytes: 0 };
  const thumbnail = chooseVisualCapture({ reason: "after-action", changed: true, estimatedBytes: 1_000 }, budget);
  assert.equal(thumbnail.mode, "thumbnail");
  const nextBudget = recordVisualCapture(budget, 1_000);
  const viewport = chooseVisualCapture({ reason: "ambiguous", ambiguous: true, estimatedBytes: 10_000 }, nextBudget);
  assert.equal(viewport.mode, "viewport");
  const exhausted = chooseVisualCapture({ reason: "user-request", userRequested: true, estimatedBytes: 10_000 }, recordVisualCapture(nextBudget, 10_000));
  assert.equal(exhausted.allowed, false);
});

test("provider circuit breaker opens, permits one probe, and closes on recovery", () => {
  let clock = 0;
  const breaker = new ProviderCircuitBreaker(2, 100, () => clock);
  assert.equal(breaker.canUse(), true);
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.canUse(), false);
  clock = 100;
  assert.equal(breaker.canUse(), true);
  assert.equal(breaker.canUse(), false);
  breaker.recordSuccess();
  assert.equal(breaker.snapshot().state, "closed");
  assert.equal(breaker.canUse(), true);
});

test("benchmark scoring distinguishes verified completion from an unverified claim", () => {
  const testCase = COMPLEX_BROWSER_CASES.find((item) => item.id === "spa-rerender")!;
  const pass = evaluateBenchmarkCase(testCase, { caseId: testCase.id, outcome: "completed", verified: true, evidenceCount: 2, duplicateEffect: false });
  const unverified = evaluateBenchmarkCase(testCase, { caseId: testCase.id, outcome: "completed", verified: false, evidenceCount: 0, duplicateEffect: false });
  assert.equal(pass.status, "pass");
  assert.equal(unverified.status, "unverified");
  assert.equal(scoreBenchmark([pass, unverified]), 0.5);
});
