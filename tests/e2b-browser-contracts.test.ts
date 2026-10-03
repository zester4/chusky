import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { E2B_BROWSER_ACTIONS } from "../src/lib/e2b/types.js";
import { assertE2BBrowserHandoffAllowsAction, isTrustedBrowserUrlObservation, normalizeE2BBrowserFileName, normalizeE2BPageContent } from "../src/lib/e2b/contracts.js";
import { shouldUseE2BBrowser } from "../src/nativeTools.js";
import { chuckTools } from "../src/agentTools.js";
import { pendingVaultInspectionOrigins } from "../src/vault/browserGuard.js";

test("the model schema and dispatcher expose exactly the supported E2B browser actions", () => {
  const schema = chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER")?.function.parameters as { properties?: { action?: { enum?: string[] } } } | undefined;
  assert.deepEqual(schema?.properties?.action?.enum, [...E2B_BROWSER_ACTIONS]);
  for (const action of E2B_BROWSER_ACTIONS) assert.equal(shouldUseE2BBrowser(action, true, true), true, action);
  assert.equal(shouldUseE2BBrowser("not-an-action", true, true), false);
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

test("human handoff blocks browser mutation until same-origin verification", () => {
  const handoff = {
    id: "bh_test", userId: 8, workspaceId: "sandbox", origin: "https://example.test", reason: "captcha" as const,
    status: "waiting" as const, createdAt: 10, expiresAt: 10_000,
  };
  assert.throws(() => assertE2BBrowserHandoffAllowsAction("click", [handoff], "https://example.test/path", "sandbox", 100), /waiting for the owner/);
  const awaiting = { ...handoff, status: "awaiting_verification" as const };
  assert.doesNotThrow(() => assertE2BBrowserHandoffAllowsAction("snapshot", [awaiting], "https://example.test/path", "sandbox", 100));
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
