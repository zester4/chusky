import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chuckTools } from "../src/agentTools.js";
import { nativeTool } from "../src/nativeTools.js";
import { toolApprovalPolicy } from "../src/policy.js";
import { WORKER_CAPABILITIES } from "../src/subagents/capabilities.js";

const agentLoopNativeTools = new Set([
  "CHUCK_CREATE_TRIGGER",
  "CHUCK_LIST_TRIGGER_APPS",
  "CHUCK_LIST_TRIGGER_TYPES",
  "CHUCK_LIST_TRIGGERS",
  "CHUCK_SET_TRIGGER_STATE",
  "CHUCK_UPDATE_TRIGGER_INSTRUCTIONS",
  "CHUCK_EMAIL_ARTIFACT",
  "CHUCK_GENERATE_IMAGE",
  "CHUCK_GENERATE_VIDEO",
  "CHUCK_LIST_CONNECTED_ACCOUNTS",
  "CHUCK_MEDIA_BRIDGE",
]);

test("every native tool has exactly one documented execution route and a policy classification", async () => {
  const [nativeSource, agentSource] = await Promise.all([
    readFile(new URL("../src/nativeTools.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agent.ts", import.meta.url), "utf8"),
  ]);
  const dispatcher = new Set([...nativeSource.matchAll(/case\s+"(CHUCK_[A-Z0-9_]+)"/g)].map((match) => match[1]!));
  const catalog = new Set(chuckTools.map((tool) => tool.function.name));

  for (const slug of catalog) {
    const hasAgentRoute = agentLoopNativeTools.has(slug) && agentSource.includes(slug);
    assert.equal(dispatcher.has(slug) || hasAgentRoute, true, `${slug} must have a dispatcher or explicit agent-loop handler`);
    assert.equal(toolApprovalPolicy(slug) === "private" || toolApprovalPolicy(slug) === "approval_required", true, `${slug} must have an approval classification`);
  }
  for (const slug of dispatcher) {
    const retiredBrowserTool = /^(?:CHUCK_BROWSER(?:_|$)|CHUCK_VAULT_|CHUCK_SHOPPING_)/.test(slug)
      || ["CHUCK_LINK_INSPECT_CHECKOUT", "CHUCK_LINK_EXECUTE_PAYMENT", "CHUCK_LINK_CONFIRM_ORDER", "CHUCK_LINK_COMPLETE_CHECKOUT"].includes(slug);
    if (!retiredBrowserTool) assert.equal(catalog.has(slug), true, `dispatcher tool ${slug} must have a published schema`);
  }
});

test("retired browser, vault, shopping, and website-checkout dispatches fail closed", async () => {
  for (const slug of [
    "CHUCK_BROWSER", "CHUCK_BROWSER_HANDOFF", "CHUCK_VAULT_LIST", "CHUCK_SHOPPING_START",
    "CHUCK_LINK_INSPECT_CHECKOUT", "CHUCK_LINK_EXECUTE_PAYMENT", "CHUCK_LINK_CONFIRM_ORDER", "CHUCK_LINK_COMPLETE_CHECKOUT",
  ]) {
    await assert.rejects(() => nativeTool(900001, slug, {}), /website browsing is unavailable/i, slug);
  }
  await assert.rejects(() => nativeTool(900001, "CHUCK_LINK_CREATE_SPEND_REQUEST", {
    amount: 1000,
    currency: "USD",
    context: "A sufficiently detailed purchase context that is intentionally not being executed through a browser-based checkout.",
  }), /Browser-based Link checkout is unavailable/i);
});

test("specialist native-tool grants refer only to published tool schemas", () => {
  const catalog = new Set(chuckTools.map((tool) => tool.function.name));
  for (const [worker, capability] of Object.entries(WORKER_CAPABILITIES)) {
    for (const slug of capability.allowedTools) assert.equal(catalog.has(slug), true, `${worker} allowlist contains unknown native tool ${slug}`);
  }
});
