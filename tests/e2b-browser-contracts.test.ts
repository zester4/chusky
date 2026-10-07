import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { E2B_BROWSER_ACTIONS } from "../src/lib/e2b/types.js";
import { assertE2BBrowserHandoffAllowsAction, browserHandoffWaitingResult, isTrustedBrowserUrlObservation, normalizeE2BBrowserFileName, normalizeE2BPageContent, resolveE2BBrowserCommandTimeout } from "../src/lib/e2b/contracts.js";
import { E2BBrowserHandoffWaitingError } from "../src/lib/e2b/errors.js";
import { shouldUseE2BBrowser } from "../src/nativeTools.js";
import { chuckTools } from "../src/agentTools.js";
import { pendingVaultInspectionOrigins } from "../src/vault/browserGuard.js";
import { auxiliaryBrowserRequest } from "../src/lib/e2b/auxiliaryActions.js";

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
  const engine = readFileSync("src/lib/e2b/browser.ts", "utf8");
  assert.match(engine, /activeTabIndex/);
  assert.match(engine, /result\.tabs/);
  assert.match(engine, /Only replay idempotent control operations/);
  assert.match(engine, /replanInteraction/);
  assert.match(engine, /stale_observation.*action_timeout.*browser_action_failed/);
  assert.match(engine, /recovery needs the control role and accessible name/);
  assert.match(engine, /retryableCode/);
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
