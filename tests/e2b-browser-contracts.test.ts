import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { E2B_BROWSER_ACTIONS } from "../src/lib/e2b/types.js";
import { assertE2BBrowserHandoffAllowsAction, browserHandoffWaitingResult, isTrustedBrowserUrlObservation, normalizeE2BBrowserFileName, normalizeE2BPageContent, resolveE2BBrowserCommandTimeout } from "../src/lib/e2b/contracts.js";
import { E2BBrowserHandoffWaitingError } from "../src/lib/e2b/errors.js";
import { shouldUseE2BBrowser } from "../src/nativeTools.js";
import { nativeTool } from "../src/nativeTools.js";
import { initStore, saveBrowserHandoff } from "../src/store.js";
import { chuckTools } from "../src/agentTools.js";
import { pendingVaultInspectionOrigins } from "../src/vault/browserGuard.js";
import { auxiliaryBrowserRequest } from "../src/lib/e2b/auxiliaryActions.js";
import { browserRunHasProgress, browserRunProgressMarker } from "../src/lib/e2b/runProgress.js";
import { findSavedBrowserControl, scoreBrowserControlRemap, selectBrowserControlRemapCandidate } from "../src/lib/e2b/browser.js";
import { browserChallengeStillActive } from "../src/lib/e2b/handoffStatus.js";

test("the model schema and dispatcher expose exactly the supported E2B browser actions", () => {
  const schema = chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER")?.function.parameters as { properties?: { action?: { enum?: string[] } } } | undefined;
  assert.deepEqual(schema?.properties?.action?.enum, [...E2B_BROWSER_ACTIONS]);
  for (const action of E2B_BROWSER_ACTIONS) assert.equal(shouldUseE2BBrowser(action, true, true), true, action);
  assert.equal(shouldUseE2BBrowser("not-an-action", true, true), false);
});

test("new E2B auxiliary actions forward bounded arguments and require fresh visual grounding", () => {
  assert.deepEqual(auxiliaryBrowserRequest("desktop_click", {
    x: 1440, y: 900, button: "right", double: true, screenshotHash: "a".repeat(32), visualFallback: true,
  }), {
    action: "desktop_click", x: 1440, y: 900, button: "right", double: true,
    screenshotHash: "a".repeat(32), visualFallback: true,
  });
  assert.deepEqual(auxiliaryBrowserRequest("desktop_type", { text: "hello", delayMs: 500 }), { action: "desktop_type", text: "hello", delayMs: 250 });
  assert.deepEqual(auxiliaryBrowserRequest("desktop_press", { key: "Escape" }), { action: "desktop_press", key: "Escape" });
  assert.deepEqual(auxiliaryBrowserRequest("clipboard_write", { text: "copy" }), { action: "clipboard_write", text: "copy" });
  assert.deepEqual(auxiliaryBrowserRequest("clipboard_read", {}), { action: "clipboard_read" });
  assert.throws(() => auxiliaryBrowserRequest("desktop_click", { x: 1, y: 1 }), /fresh screenshotHash/);
  assert.throws(() => auxiliaryBrowserRequest("desktop_click", {
    x: 1441, y: 1, screenshotHash: "a".repeat(32), visualFallback: true,
  }), /inside the 1440x900/);
  assert.throws(() => auxiliaryBrowserRequest("clipboard_write", { text: "x".repeat(8_001) }), /at most 8000/);
});

test("adaptive browser primitives preserve their execution payloads", () => {
  const step = { action: "click", selector: { role: "button", name: "Search" } };
  const schema = { type: "object", properties: { title: { type: "string" } } };
  assert.deepEqual(auxiliaryBrowserRequest("observe", {
    includeScreenshot: true,
    includeForms: false,
    includePageContent: true,
    includeLinks: true,
  }), {
    action: "observe",
    includeScreenshot: true,
    includeForms: false,
    includePageContent: true,
    includeLinks: true,
  });
  assert.deepEqual(auxiliaryBrowserRequest("act", { step }), { action: "act", step });
  assert.deepEqual(auxiliaryBrowserRequest("extract", { schema }), { action: "extract", schema });
  assert.throws(() => auxiliaryBrowserRequest("act", {}), /one bounded browser step/);
  assert.throws(() => auxiliaryBrowserRequest("extract", {}), /bounded object schema/);
});

test("browser run progress markers ignore volatile screenshot data but detect page movement", () => {
  const first = browserRunProgressMarker({
    observedUrl: "https://example.test/search",
    title: "Search",
    accessibilityHash: "abc",
    pageGeneration: 4,
    screenshotHash: "volatile-a",
    screenshotId: "shot-a",
  });
  const samePage = browserRunProgressMarker({
    observedUrl: "https://example.test/search",
    title: "Search",
    accessibilityHash: "abc",
    pageGeneration: 4,
    screenshotHash: "volatile-b",
    screenshotId: "shot-b",
  });
  const nextPage = browserRunProgressMarker({
    observedUrl: "https://example.test/cart",
    title: "Cart",
    accessibilityHash: "def",
    pageGeneration: 5,
  });
  assert.equal(browserRunHasProgress(first, samePage), false);
  assert.equal(browserRunHasProgress(first, nextPage), true);
});

test("browser run progress markers detect non-sensitive form advancement", () => {
  const empty = browserRunProgressMarker({
    observedUrl: "https://example.test/signup",
    forms: [{ controls: [{ id: "email", role: "textbox", name: "Email", valuePresent: false, valueLength: 0 }] }],
  });
  const filled = browserRunProgressMarker({
    observedUrl: "https://example.test/signup",
    forms: [{ controls: [{ id: "email", role: "textbox", name: "Email", valuePresent: true, valueLength: 22 }] }],
  });
  assert.equal(browserRunHasProgress(empty, filled), true);
  assert.equal(filled.includes("example-password"), false);
});

test("form inspection is a structured, safe browser capability", () => {
  const schema = chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER")?.function.parameters as { properties?: { action?: { enum?: string[] } } } | undefined;
  assert.ok(schema?.properties?.action?.enum?.includes("form_inspect"));
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  assert.match(agent, /async function inspectForms/);
  assert.match(agent, /validationMessage/);
  assert.match(agent, /valuePresent/);
  assert.match(agent, /selectedText/);
  assert.match(agent, /validationMessage/);
  assert.match(agent, /formMutation/);
  assert.match(agent, /form_inspect/);
  assert.match(agent, /form_fill/);
  assert.match(agent, /applyFormControl/);
  assert.match(agent, /screenshotHash/);
  assert.match(agent, /Visual target is stale/);
  assert.match(agent, /workflowCheckpoint/);
  assert.match(agent, /page\.keyboard\.press\("Control\+A"\)/);
  assert.match(agent, /Dropdown option/);
  assert.match(agent, /async function clickControl/);
  assert.match(agent, /force: true/);
  assert.match(agent, /selectUniqueAutocomplete/);
  assert.match(agent, /async function isDirectAddressControl/);
  assert.match(agent, /directAddressEntry/);
  assert.match(agent, /addressCommitAttempted/);
  assert.match(agent, /locator\.press\("Enter"\)/);
  assert.match(agent, /aria-autocomplete/);
  assert.match(agent, /autocompleteCommittedByPage/);
    assert.match(agent, /setAttribute\(['"]role['"],\s*['"]option['"]\)/);
  const engine = readFileSync("src/lib/e2b/browser.ts", "utf8");
  assert.match(engine, /activeTabIndex/);
  assert.match(engine, /result\.tabs/);
  assert.match(engine, /Only replay idempotent control operations/);
  assert.match(engine, /replanInteraction/);
  assert.match(engine, /sameStableIdentity/);
  assert.match(engine, /const stale =/);
  assert.match(engine, /SAFE_REPLAN_ACTIONS as readonly string\[\]\)\.includes\(action\)/);
  assert.match(engine, /stale_observation.*action_timeout.*browser_action_failed/);
  assert.match(engine, /recovery needs the control role and accessible name/);
  assert.match(engine, /retryableCode/);
  assert.match(engine, /lastActionGuard/);
  assert.match(engine, /repeated action because the page made no progress/);
  assert.doesNotMatch(engine, /retryable = .*click/);
  assert.doesNotMatch(agent, /forms.*password.*value/);
});

test("browser reliability contract keeps visual fallback fresh and checkpoints non-sensitive", () => {
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  const engine = readFileSync("src/lib/e2b/browser.ts", "utf8");
  assert.match(engine, /form_plan/);
  assert.match(engine, /planFormSubmission/);
  assert.match(agent, /completedControls/);
  assert.match(agent, /Visual coordinate clicks require a screenshotHash/);
  assert.match(agent, /Correct the reported validation errors/);
  assert.doesNotMatch(agent, /workflowCheckpoint.*value/);
});

test("page content is bounded, sanitized, and explicit about truncation", () => {
  const sample = `contact owner@example.com ${"A useful paragraph ".repeat(40)}${"more content ".repeat(100)}`;
  const result = normalizeE2BPageContent(sample, 320);
  assert.ok(result.text.length <= 320);
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[email\]/);
  assert.doesNotMatch(result.text, /owner@example\.com/);
});

test("browser filenames cannot retain paths or control characters", () => {
  assert.equal(normalizeE2BBrowserFileName("..\\..\\private\u0000report.pdf"), "private_report.pdf");
  assert.equal(normalizeE2BBrowserFileName("../"), "browser-download.bin");
});

test("browser command timeouts are bounded by the configured request ceiling", () => {
  assert.equal(resolveE2BBrowserCommandTimeout(undefined, 120_000), 120_000);
  assert.equal(resolveE2BBrowserCommandTimeout(90_000, 120_000), 90_000);
  assert.equal(resolveE2BBrowserCommandTimeout(200_000, 120_000), 120_000);
  assert.equal(resolveE2BBrowserCommandTimeout(90_000, 45_000), 45_000);
  for (const value of [0, -1, 999, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "90000"]) {
    assert.throws(() => resolveE2BBrowserCommandTimeout(value, 120_000), /timeoutMs must be a positive whole number/);
  }
  assert.throws(() => resolveE2BBrowserCommandTimeout(undefined, 500), /configured E2B request timeout is invalid/);
});

test("human handoff blocks browser mutation until same-origin verification", () => {
  const handoff = {
    id: "bh_test", userId: 8, workspaceId: "sandbox", origin: "https://example.test", reason: "captcha" as const,
    status: "waiting" as const, createdAt: 10, expiresAt: 10_000,
  };
  assert.throws(
    () => assertE2BBrowserHandoffAllowsAction("click", [handoff], "https://example.test/path", "sandbox", 100),
    (error) => error instanceof E2BBrowserHandoffWaitingError
      && error.code === "handoff_waiting_for_owner"
      && error.handoffId === handoff.id
      && error.expiresAt === handoff.expiresAt,
  );
  assert.throws(() => assertE2BBrowserHandoffAllowsAction("open", [handoff], "https://example.test/path", "sandbox", 100), E2BBrowserHandoffWaitingError);
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("status", [handoff], "https://example.test/path", "sandbox", 100));
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("stop", [handoff], "https://example.test/path", "sandbox", 100));
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("screenshot", [handoff], "https://example.test/path", "sandbox", 100));
  const waitingResult = browserHandoffWaitingResult(new E2BBrowserHandoffWaitingError(handoff.id, handoff.expiresAt), "click");
  assert.equal(waitingResult.status, "waiting_for_owner");
  assert.equal(waitingResult.handoffId, handoff.id);
  assert.match(waitingResult.next, /Do not retry browser actions/);
  assert.equal("url" in waitingResult, false);
  const screenshotResult = browserHandoffWaitingResult(new E2BBrowserHandoffWaitingError(handoff.id, handoff.expiresAt), "screenshot");
  assert.match(screenshotResult.next, /screenshot was captured/);
  assert.doesNotMatch(screenshotResult.next, /^.*Do not retry browser actions\./);
  const awaiting = { ...handoff, status: "awaiting_verification" as const };
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("snapshot", [awaiting], "https://example.test/path", "sandbox", 100));
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("screenshot", [awaiting], "https://example.test/path", "sandbox", 100));
  assert.throws(() => assertE2BBrowserHandoffAllowsAction("open", [awaiting], "https://example.test/path", "sandbox", 100), /awaiting same-origin verification/);
  assert.throws(() => assertE2BBrowserHandoffAllowsAction("snapshot", [awaiting], "https://attacker.test/", "sandbox", 100), /awaiting same-origin verification/);
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("click", [handoff], "https://example.test", "sandbox", 20_000));
});

test("browser recovery remaps re-rendered transportation location controls without guessing", () => {
  const pickup = { nodeId: "old-pickup", role: "textbox", name: "Pickup location", index: 0, frameIndex: 0, url: "https://ride.example", capturedAt: 1 };
  const currentPickup = { nodeId: "new-pickup", role: "combobox", name: "Where should we pick you up?", index: 1, frameIndex: 0, url: "https://ride.example", capturedAt: 2 };
  const currentDropoff = { ...currentPickup, nodeId: "new-dropoff", name: "Where are you going?", index: 2 };
  assert.ok(scoreBrowserControlRemap(pickup, currentPickup) >= 28);
  assert.equal(scoreBrowserControlRemap(pickup, currentDropoff), 0);
  const genericPickup = { ...pickup, nodeId: "generic-pickup", role: "combobox", name: "Search for a location", index: 0 };
  const genericDropoff = { ...genericPickup, nodeId: "generic-dropoff", index: 1 };
  assert.ok(scoreBrowserControlRemap(pickup, genericPickup) >= 28);
  assert.equal(selectBrowserControlRemapCandidate(pickup, [genericPickup, genericDropoff])?.nodeId, "generic-pickup");
  assert.equal(scoreBrowserControlRemap(pickup, { ...currentPickup, frameIndex: 1 }), scoreBrowserControlRemap(pickup, currentPickup));
  const engine = readFileSync("src/lib/e2b/browser.ts", "utf8");
  assert.match(engine, /LOCATION_INTENTS/);
  assert.match(engine, /compatibleControlRole/);
  assert.match(engine, /scoreBrowserControlRemap/);
  assert.match(engine, /sameFrame/);
  assert.match(engine, /semantic scores tie/);
});

test("browser recovery chooses the unique semantic location candidate and preserves the prior index on ties", async () => {
  const engine = readFileSync("src/lib/e2b/browser.ts", "utf8");
  assert.match(engine, /selectBrowserControlRemapCandidate/);
  assert.match(engine, /scoreBrowserControlRemap/);
});

test("browser recovery reuses an unambiguous saved control when the model omits nodeId", () => {
  const saved = [
    { nodeId: "pickup", role: "textbox", name: "Pickup location", index: 0, url: "https://ride.example", capturedAt: 1 },
    { nodeId: "dropoff", role: "textbox", name: "Dropoff location", index: 1, url: "https://ride.example", capturedAt: 1 },
  ];
  assert.equal(findSavedBrowserControl(saved, { role: "combobox", name: "Pickup location" }, "combobox", "Pickup location")?.nodeId, "pickup");
  assert.equal(findSavedBrowserControl(saved, { role: "combobox", name: "Unknown location" }, "combobox", "Unknown location"), undefined);
  assert.match(readFileSync("src/lib/e2b/browser.ts", "utf8"), /findSavedBrowserControl/);
});

test("resuming an incomplete handoff returns a waiting state without touching E2B", async () => {
  await initStore({ memoryOnly: true });
  const userId = 991_701;
  const id = "bh_waiting_regression";
  await saveBrowserHandoff(userId, {
    id,
    userId,
    workspaceId: "sandbox-waiting-regression",
    origin: "https://example.test",
    reason: "captcha",
    status: "waiting",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const result = await nativeTool(userId, "CHUCK_BROWSER_HANDOFF_RESUME", { id }, { ownerPrivateRun: true }) as Record<string, unknown>;
  assert.equal(result.status, "waiting_for_owner");
  assert.equal(result.needsUserInteraction, true);
  assert.match(String(result.next), /CHUCK_BROWSER_HANDOFF_COMPLETE/);
});

test("handoff completion requires the fresh observation to clear the challenge", () => {
  assert.equal(browserChallengeStillActive({ needsUserInteraction: true, challenge: { detected: true } }), true);
  assert.equal(browserChallengeStillActive({ needsUserInteraction: false, challenge: { detected: true } }), true);
  assert.equal(browserChallengeStillActive({ needsUserInteraction: false, challenge: { detected: false } }), false);
  assert.equal(browserChallengeStillActive({}), false);
});

test("handoff verification trusts direct Playwright URL observations but rejects unproven browser URLs", () => {
  assert.equal(isTrustedBrowserUrlObservation("e2b", "playwright_page_url"), true);
  assert.equal(isTrustedBrowserUrlObservation("daytona", "playwright_page_url"), false);
  assert.equal(isTrustedBrowserUrlObservation("e2b", undefined), false);
  assert.equal(isTrustedBrowserUrlObservation("daytona", "address_bar"), true);
});

test("vault SSO handoff permits read-only verification at the exact active IdP origin", () => {
  const handoff = {
    id: "bh_sso", userId: 8, workspaceId: "sandbox", origin: "https://identity.example.net", credentialId: "cred_1",
    reason: "login" as const, status: "awaiting_verification" as const, createdAt: 10, expiresAt: 10_000,
  };
  const origins = pendingVaultInspectionOrigins(["https://shop.example.com"], [handoff], "sandbox", 100);
  assert.deepEqual(origins.sort(), ["https://identity.example.net", "https://shop.example.com"]);
  assert.deepEqual(pendingVaultInspectionOrigins(["https://shop.example.com"], [handoff], "other-sandbox", 100), ["https://shop.example.com"]);
  assert.deepEqual(pendingVaultInspectionOrigins(["https://shop.example.com"], [{ ...handoff, status: "waiting" }], "sandbox", 100), ["https://shop.example.com"]);
  assert.deepEqual(pendingVaultInspectionOrigins(["https://shop.example.com"], [{ ...handoff, expiresAt: 99 }], "sandbox", 100), ["https://shop.example.com"]);
});

test("E2B template and runtime contract include the bounded file and recording paths", () => {
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  const docker = readFileSync("e2b/browser-template/Dockerfile", "utf8");
  assert.match(agent, /acceptDownloads:\s*true/);
  assert.match(agent, /page\.on\("download"/);
  assert.match(agent, /setInputFiles/);
  assert.match(agent, /ffmpeg/);
  assert.match(docker, /ffmpeg/);
});

test("E2B template exposes the advanced desktop, lifecycle, diagnostics, and PDF paths", () => {
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  const client = readFileSync("e2b/browser-template/browser-client.mjs", "utf8");
  for (const marker of ["desktop_click", "desktop_type", "clipboard_read", "diagnostics", "dialog_list", "Page.printToPDF", "CHUSKY_BROWSER_LOCALE", "permissions: [\"clipboard-read\", \"clipboard-write\"]"]) assert.match(agent, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  assert.match(client, /CHUSKY_E2B_RESPONSE_FILE/);
});
