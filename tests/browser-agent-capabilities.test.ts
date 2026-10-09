import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { E2B_BROWSER_ACTIONS } from "../src/lib/e2b/types.js";
import { extractBrowserSchema } from "../src/lib/e2b/extraction.js";
import { classifyBrowserRecovery } from "../src/lib/e2b/recovery.js";
import { browserTraceEvent, redactBrowserTrace } from "../src/lib/e2b/trace.js";
import { BrowserSessionPool } from "../src/lib/browser-runtime/pool.js";
import { rankBrowserTargets } from "../src/lib/e2b/vision.js";
import { browserBenchmarkCases } from "../benchmarks/browser-cases.js";
import { browserAgentProgressMarker, browserAgentStepKey, normalizeBrowserAgentRunLimits } from "../src/lib/e2b/agentRunPolicy.js";

test("browser exposes the adaptive observe/act/extract/agent protocol", () => {
  for (const action of ["observe", "act", "extract", "agent"]) assert.equal(E2B_BROWSER_ACTIONS.includes(action), true, action);
});

test("bounded browser-agent policy clamps work and identifies repeated steps without observations", () => {
  assert.deepEqual(normalizeBrowserAgentRunLimits({ maxSteps: 100, maxActions: 80, maxDurationMs: 500_000, noProgressLimit: 10 }), {
    maxSteps: 50,
    maxActions: 50,
    maxDurationMs: 120_000,
    noProgressLimit: 3,
  });
  const first = browserAgentStepKey({ action: "fill", selector: { role: "textbox", name: "Pickup location", observationId: "old" }, value: "90503" });
  const second = browserAgentStepKey({ action: "fill", selector: { role: "textbox", name: "Pickup location", observationId: "new" }, value: "90503" });
  assert.equal(first, second);
  assert.equal(browserAgentProgressMarker({ observedUrl: "https://example.test", title: "Page", accessibilityHash: "same" }), browserAgentProgressMarker({ observedUrl: "https://example.test", title: "Page", accessibilityHash: "same" }));
});

test("the E2B template contains hard stops for deadline, failed assertions, and no progress", () => {
  const source = readFileSync(new URL("../e2b/browser-template/browser-agent.mjs", import.meta.url), "utf8");
  assert.match(source, /maxDurationMs/);
  assert.match(source, /expectation_failed/);
  assert.match(source, /no_progress/);
  assert.match(source, /stop_and_reobserve/);
  assert.match(source, /stoppedReason = "challenge"/);
  assert.match(source, /completion_assertion_failed/);
  assert.match(source, /verified/);
  assert.match(source, /completionAssertions/);
});

test("the E2B template keeps headed browser features enabled unless software rendering is explicit", () => {
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  assert.match(agent, /headless:\s*false/);
  assert.match(agent, /launchPersistentContext/);
  assert.match(agent, /locale: process\.env\.CHUSKY_BROWSER_LOCALE \|\| "en-US"/);
  assert.match(agent, /timezoneId: process\.env\.CHUSKY_BROWSER_TIMEZONE \|\| "America\/New_York"/);
  assert.match(agent, /CHUSKY_BROWSER_DISABLE_GPU/);
  assert.doesNotMatch(agent, /args:\s*\[[^\]]*"--disable-gpu"/);
});

test("bounded browser-agent completion is explicit and observable", () => {
  const engine = readFileSync(new URL("../src/lib/e2b/browser.ts", import.meta.url), "utf8");
  const toolSchema = readFileSync(new URL("../src/agentTools.ts", import.meta.url), "utf8");
  assert.match(engine, /completionAssertions/);
  assert.match(engine, /internal\.signal/);
  assert.match(toolSchema, /Required final business-state checks/);
  assert.match(toolSchema, /failed completion assertion/);
});

test("schema extraction returns only explicitly requested controls", () => {
  const result = extractBrowserSchema({ forms: [{ formId: "f", controls: [
    { name: "Country", role: "combobox", required: true, disabled: false, selectedText: "Ghana" },
    { name: "Terms", role: "checkbox", required: true, disabled: false, checked: true },
  ], submitControls: [] }] }, { type: "object", properties: { country: { label: "country" }, terms: { label: "terms", role: "checkbox" }, secret: { label: "secret" } } });
  assert.deepEqual(result, { country: "Ghana", terms: true });
});

test("recovery forces fresh observation for stale and challenge states", () => {
  assert.deepEqual(classifyBrowserRecovery(new Error("stale_observation")), { retry: true, reobserve: true, reason: "stale_observation", nextAction: "observe" });
  assert.equal(classifyBrowserRecovery(new Error("captcha detected")).nextAction, "handoff");
});

test("trace identifiers are safe and owner ids are redacted for presentation", () => {
  const event = browserTraceEvent({ ownerId: 7, provider: "e2b", phase: "observe", status: "succeeded" });
  assert.match(event.id, /^bt_/);
  assert.equal("ownerId" in redactBrowserTrace([event])[0], false);
});

test("visual grounding ranks semantic targets before coordinate fallback", () => {
  const ranked = rankBrowserTargets([
    { nodeId: "1", role: "button", name: "Create account", index: 0, url: "https://example.test", capturedAt: 1 },
    { nodeId: "2", role: "link", name: "Create account help", index: 1, url: "https://example.test", capturedAt: 1 },
  ], "Create account", "button");
  assert.equal(ranked[0].node.nodeId, "1");
  assert.match(ranked[0].reasons.join(" "), /exact/);
});

test("browser session pools enforce owner-scoped concurrency and release safely", () => {
  const pool = new BrowserSessionPool(1);
  const lease = pool.acquire(7);
  assert.throws(() => pool.acquire(7), /concurrency limit/);
  assert.equal(pool.activeFor(8), 0);
  lease.release(); lease.release();
  assert.equal(pool.activeFor(7), 0);
});

test("benchmark manifest covers the requested browser reliability surfaces", () => {
  const tags = new Set(browserBenchmarkCases.flatMap((item) => item.tags));
  for (const tag of ["form", "visual", "extract", "self-healing", "checkpoint", "tabs", "iframe", "shadow-dom", "handoff"]) assert.equal(tags.has(tag), true, tag);
});
