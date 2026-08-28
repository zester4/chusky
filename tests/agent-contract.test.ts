import test from "node:test";
import assert from "node:assert/strict";
import { getSession, initStore } from "../src/store.js";
import { invalidateSession, runAgent, ApprovalRequiredError, setAgentDependenciesForTests } from "../src/agent.js";

function chatResponse(message: any) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function toolResponse(name: string, args: string) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: args } }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

async function withAgentMocks(responses: Response[], execute: (slug: string, args: any) => unknown, fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  let index = 0;
  const session = {
    sessionId: "test-composio-session",
    tools: async () => [],
    execute,
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    return responses[index++] ?? chatResponse({ role: "assistant", content: "unexpected extra request" });
  }) as typeof fetch;
  try { await fn(); } finally {
    globalThis.fetch = originalFetch;
  }
}

test("agent uses the selected model for a normal text response", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830001);
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    models.push(JSON.parse(String(init?.body)).model);
    return chatResponse({ role: "assistant", content: "done" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "text-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830001, "hello", [], "test/model");
    assert.equal(result.text, "done");
    assert.deepEqual(models, ["test/model"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent executes a safe tool and feeds its result into the next model round", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830002);
  const executed: any[] = [];
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7 })),
    chatResponse({ role: "assistant", content: "tool complete" }),
  ], async (slug, args) => { executed.push({ slug, args }); return { ok: true }; }, async () => {
    const result = await runAgent(830002, "do it", [], "test/model");
    assert.equal(result.text, "tool complete");
    assert.deepEqual(executed, [{ slug: "TEST_SAFE_TOOL", args: { value: 7 } }]);
    assert.deepEqual(result.toolsUsed, ["TEST_SAFE_TOOL"]);
  });
});

test("risky tool calls stop before execution and approved exact calls execute once", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830003);
  let executions = 0;
  await withAgentMocks([toolResponse("GMAIL_SEND_EMAIL", JSON.stringify({ to: "user@example.com" }))], async () => { executions++; }, async () => {
    await assert.rejects(() => runAgent(830003, "send it", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    assert.equal(executions, 0);
    const approval = (await getSession(830003)).approvals[0];
    assert.equal(approval.toolSlug, "GMAIL_SEND_EMAIL");
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(830003, approval.id, "approved"));
    await withAgentMocks([
      toolResponse("GMAIL_SEND_EMAIL", JSON.stringify({ to: "user@example.com" })),
      chatResponse({ role: "assistant", content: "sent" }),
    ], async () => { executions++; }, async () => {
      const result = await runAgent(830003, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
      assert.equal(result.text, "sent");
    });
    assert.equal(executions, 1);
  });
});

test("malformed tool JSON becomes a controlled tool error and the loop continues", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830004);
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", "not-json"),
    chatResponse({ role: "assistant", content: "recovered" }),
  ], async () => undefined, async () => {
    const result = await runAgent(830004, "recover", [], "test/model");
    assert.equal(result.text, "recovered");
  });
});

test("agent retries transient OpenRouter responses with a bounded retry", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830005);
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    chatAttempts++;
    if (chatAttempts === 1) return new Response("temporary", { status: 503 });
    return chatResponse({ role: "assistant", content: "retried" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "retry-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830005, "retry", [], "test/model");
    assert.equal(result.text, "retried");
    assert.equal(chatAttempts, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent routes unsupported image input to the configured vision model", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830006);
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    models.push(JSON.parse(String(init?.body)).model);
    return chatResponse({ role: "assistant", content: "image understood" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "vision-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830006, [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }], [], "test/model");
    assert.equal(result.text, "image understood");
    assert.equal(models[0], "openai/gpt-5.6-luna");
  } finally { globalThis.fetch = originalFetch; }
});
