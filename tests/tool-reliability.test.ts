import test from "node:test";
import assert from "node:assert/strict";
import { preflightToolCall, summarizeIntegrationHealth, inspectToolRecovery } from "../src/toolDiagnostics.js";
import { buildArtifactUploadArguments } from "../src/artifactBridge.js";
import { nativeTool } from "../src/nativeTools.js";
import { getAgentRun, initStore, saveAgentRun } from "../src/store.js";

const tool = (name: string, parameters: Record<string, unknown>) => ({
  type: "function",
  function: { name, parameters },
});

test("tool preflight validates only an exact currently exposed schema and marks approval", () => {
  const catalog = [tool("GITHUB_DELETE_REPOSITORY", {
    type: "object", required: ["owner", "repo"],
    properties: { owner: { type: "string" }, repo: { type: "string" } },
  })];
  const ready = preflightToolCall(catalog, "GITHUB_DELETE_REPOSITORY", { owner: "acme", repo: "site" });
  assert.equal(ready.status, "approval_required");
  assert.equal(ready.available, true);
  assert.equal(ready.argumentsValid, true);
  assert.equal(ready.approvalRequired, true);

  const invalid = preflightToolCall(catalog, "GITHUB_DELETE_REPOSITORY", { owner: "acme" });
  assert.equal(invalid.status, "invalid_arguments");
  assert.equal(invalid.argumentsValid, false);
  assert.match(invalid.message, /repo/);
  const hidden = preflightToolCall(catalog, "SLACK_POST_MESSAGE", { channel: "x" });
  assert.equal(hidden.status, "unavailable");
  assert.equal(hidden.argumentsValid, null);
});

test("integration health never calls unknown statuses healthy or leaks credentials", () => {
  assert.equal(summarizeIntegrationHealth(undefined).status, "unknown");
  assert.equal(summarizeIntegrationHealth([]).status, "not_connected");
  const health = summarizeIntegrationHealth([
    { id: "safe-id", toolkit: "gmail", status: "ACTIVE", alias: "work" },
    { id: "expired-id", toolkit: "gmail", status: "EXPIRED", alias: "old" },
  ], "gmail");
  assert.equal(health.status, "attention_required");
  assert.equal(health.accounts.length, 2);
  assert.equal(JSON.stringify(health).includes("token"), false);
  assert.equal(summarizeIntegrationHealth([{ id: "x", toolkit: "mystery", status: "SOMETHING_NEW" }]).status, "unknown");
});

test("tool recovery is owner-scoped input evidence and never blindly recommends replay", () => {
  const events = [
    { id: "1", type: "run.tool_result", at: 1, data: { tool: "GMAIL_SEND_EMAIL", callId: "sent", ok: false, retrySafety: "verify_first", failureClass: "Error" } },
    { id: "2", type: "run.tool_result", at: 2, data: { tool: "CHUCK_SEARCH_SKILLS", callId: "bad_args", ok: false, retrySafety: "safe_retry", failureClass: "ValidationError" } },
  ];
  assert.equal(inspectToolRecovery(events, "sent").retryAdvice, "verify_first");
  assert.equal(inspectToolRecovery(events, "bad_args").retryAdvice, "safe_retry");
  assert.equal(inspectToolRecovery(events, "other").status, "not_found");
  assert.equal(inspectToolRecovery([{ id: "3", type: "run.tool_result", at: 3, data: { tool: "SLACK_POST_MESSAGE", callId: "old", ok: false } }], "old").retryAdvice, "verify_first");
});

test("file bridge maps only an unambiguous schema-declared binary field and keeps bytes server-side", () => {
  const input = {
    type: "object", properties: { parent: { type: "string" },
    file: { type: "object", required: ["name", "data", "mime_type"], properties: {
      name: { type: "string" }, data: { type: "string", description: "base64 encoded file bytes" }, mime_type: { type: "string" },
    } } },
  };
  const args = { parent: "folder_123" };
  const result = buildArtifactUploadArguments(input, args, { name: "brief.pdf", contentType: "application/pdf", data: Buffer.from("pdf-bytes") });
  assert.equal(JSON.stringify(result).includes("pdf-bytes"), false);
  assert.deepEqual(args, { parent: "folder_123" });
  assert.deepEqual(result, { parent: "folder_123", file: { name: "brief.pdf", data: Buffer.from("pdf-bytes").toString("base64"), mime_type: "application/pdf" } });
  assert.throws(() => buildArtifactUploadArguments({ type: "object", properties: { content: { type: "string" } } }, {}, { name: "brief.txt", contentType: "text/plain", data: Buffer.from("x") }), /unambiguous.*binary/i);
  assert.throws(() => buildArtifactUploadArguments({ type: "object", properties: { file: input.properties.file, attachments: { type: "array", items: input.properties.file } } }, {}, { name: "brief.pdf", contentType: "application/pdf", data: Buffer.from("x") }), /multiple possible file containers/i);
  assert.throws(() => buildArtifactUploadArguments(input, { file: "caller-provided" }, { name: "brief.pdf", contentType: "application/pdf", data: Buffer.from("x") }), /do not supply/i);
});

test("native reliability tools use the current run catalog and safe owner connection snapshot", async () => {
  await initStore({ memoryOnly: true });
  const preflight = await nativeTool(101, "CHUCK_TOOL_PREFLIGHT", {
    toolName: "GITHUB_DELETE_REPOSITORY", arguments: { owner: "acme", repo: "site" },
  }, { toolCatalog: [tool("GITHUB_DELETE_REPOSITORY", { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] })] }) as { status: string; approvalRequired: boolean };
  assert.equal(preflight.status, "approval_required");
  assert.equal(preflight.approvalRequired, true);

  const health = await nativeTool(101, "CHUCK_INTEGRATION_HEALTH", { toolkit: "gmail" }, {
    connectedAccounts: [{ id: "account-safe-id", toolkit: "gmail", status: "ACTIVE", alias: "work" }],
  }) as { status: string; accounts: Array<{ id: string }> };
  assert.equal(health.status, "connected");
  assert.deepEqual(health.accounts.map((account) => account.id), ["account-safe-id"]);
  await assert.rejects(nativeTool(101, "CHUCK_FILE_BRIDGE", { artifactId: "artifact_123", toolSlug: "DRIVE_UPLOAD_FILE", arguments: {} }), /authenticated agent Composio-session dispatcher/);
  await assert.rejects(nativeTool(101, "CHUCK_INTEGRATION_HEALTH", {}, { sharedConversation: true }), /private owner conversation/);
});

test("tool recovery reads persisted results only for the requesting owner and never dispatches a retry", async () => {
  await initStore({ memoryOnly: true });
  const run = {
    id: "run_owner_101", userId: 101, kind: "supervisor" as const, objective: "Inspect a failed call", status: "failed" as const,
    version: 0, createdAt: 10, updatedAt: 20,
    events: [{ id: "event_1", type: "run.tool_result", at: 20, data: { tool: "GMAIL_SEND_EMAIL", callId: "call_1", ok: false, retrySafety: "verify_first", failureClass: "Error" } }],
  };
  await saveAgentRun(run);
  assert.equal((await getAgentRun(202, run.id)), undefined);
  const result = await nativeTool(101, "CHUCK_TOOL_RECOVERY", { runId: run.id, toolCallId: "call_1" }) as { status: string; retryAdvice: string; toolCallId: string };
  assert.deepEqual({ status: result.status, retryAdvice: result.retryAdvice, toolCallId: result.toolCallId }, { status: "failed", retryAdvice: "verify_first", toolCallId: "call_1" });
  const hidden = await nativeTool(202, "CHUCK_TOOL_RECOVERY", { runId: run.id });
  assert.equal((hidden as { status: string }).status, "not_found");
});
