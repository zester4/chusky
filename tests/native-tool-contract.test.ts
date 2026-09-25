import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chuckTools } from "../src/agentTools.js";
import { toolApprovalPolicy } from "../src/policy.js";
import { WORKER_CAPABILITIES } from "../src/subagents/capabilities.js";

const agentLoopNativeTools = new Set([
  "CHUCK_CREATE_TRIGGER",
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
  for (const slug of dispatcher) assert.equal(catalog.has(slug), true, `dispatcher tool ${slug} must have a published schema`);
});

test("specialist native-tool grants refer only to published tool schemas", () => {
  const catalog = new Set(chuckTools.map((tool) => tool.function.name));
  for (const [worker, capability] of Object.entries(WORKER_CAPABILITIES)) {
    for (const slug of capability.allowedTools) assert.equal(catalog.has(slug), true, `${worker} allowlist contains unknown native tool ${slug}`);
  }
});
