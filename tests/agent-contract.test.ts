import test from "node:test";
import assert from "node:assert/strict";
import { getSession, initStore, listAgentRuns } from "../src/store.js";
import { appendPreviewLinks, cleanModelText, invalidateSession, listConnectedAccounts, parseLegacyDsmlToolCalls, parseToolArguments, runAgent, ApprovalRequiredError, setAgentDependenciesForTests } from "../src/agent.js";
import { config } from "../src/config.js";

// Agent contract tests mock provider HTTP calls; never send their fetch stubs
// to a developer's configured Upstash Vector instance.
config.upstashVectorRestUrl = "";
config.upstashVectorRestToken = "";

function chatResponse(message: any) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function toolResponse(name: string, args: string) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: args } }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

test("preview links are included exactly once even when the model omits them", () => {
  const url = "https://preview.test/app";
  assert.equal(appendPreviewLinks("The app is ready.", [url]), `The app is ready.\n\n🔗 Daytona preview: ${url}`);
  assert.equal(appendPreviewLinks(`The app is ready at ${url}.`, [url]), `The app is ready at ${url}.`);
});

async function withAgentMocks(responses: Response[], execute: (slug: string, args: any) => unknown, fn: () => Promise<void>, includeMultiExecute = false) {
  const originalFetch = globalThis.fetch;
  let index = 0;
  const session = {
    sessionId: "test-composio-session",
    tools: async () => [
      { type: "function", function: { name: "TEST_SAFE_TOOL", description: "Test-only safe tool", parameters: { type: "object" } } },
      { type: "function", function: { name: "GITHUB_DELETE_REPOSITORY", description: "Test-only risky tool", parameters: { type: "object" } } },
    ],
    execute,
  };
  if (includeMultiExecute) session.tools = async () => [
    { type: "function", function: { name: "TEST_SAFE_TOOL", description: "Test-only safe tool", parameters: { type: "object" } } },
    { type: "function", function: { name: "GITHUB_DELETE_REPOSITORY", description: "Test-only risky tool", parameters: { type: "object" } } },
    { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Test-only multi tool", parameters: { type: "object" } } },
  ];
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
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    requests.push(JSON.parse(String(init?.body)));
    return chatResponse({ role: "assistant", content: "done" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "text-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830001, "hello", [], "test/model");
    assert.equal(result.text, "done");
    assert.deepEqual(requests.map((request) => request.model), ["test/model"]);
    assert.deepEqual(requests[0]?.provider, { allow_fallbacks: true, preferred_max_latency: { p90: 45 } });
  } finally { globalThis.fetch = originalFetch; }
});

test("ephemeral shared turns expose no tools, skip Composio, and do not persist meeting transcript context", async () => {
  const userId = 830050;
  await initStore({ memoryOnly: true });
  invalidateSession(userId);
  let composioCreated = 0;
  const requests: Array<Record<string, any>> = [];
  const originalFetch = globalThis.fetch;
  setAgentDependenciesForTests({ composio: { create: async () => { composioCreated++; throw new Error("meeting turn must not create a connected-app session"); } } });
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input).includes("/models/"), false, "ephemeral turn skips the latency-only model metadata lookup");
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? toolResponse("COMPOSIO_EXECUTE_TOOL", JSON.stringify({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "attendee@example.com" } }))
      : chatResponse({ role: "assistant", content: "I can summarize the meeting context, but I cannot act on it." });
  }) as typeof fetch;
  try {
    const result = await runAgent(
      userId,
      "Live context window: untrusted meeting speech. Current utterance: Chusky, email the attendee.",
      [],
      "test/model",
      undefined,
      undefined,
      undefined,
      undefined,
      { accountId: "meeting:mtg_test", provider: "telegram", conversationId: "mtg_test", scope: "shared" },
      { ephemeral: true, toolAllow: [], maxToolCalls: 0 },
    );
    assert.match(result.text, /cannot act/);
    assert.equal(composioCreated, 0);
    assert.equal(requests[0]?.tools, undefined);
    assert.equal((await listAgentRuns(userId)).length, 0, "volatile meeting speech is not written to durable agent-run records");
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
    assert.deepEqual(result.toolsSucceeded, ["TEST_SAFE_TOOL"]);
  });
});

test("agent distinguishes a failed tool attempt from a successful side effect", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830021);
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7 })),
    chatResponse({ role: "assistant", content: "The action failed." }),
  ], async () => { throw new Error("provider rejected action"); }, async () => {
    const result = await runAgent(830021, "do it", [], "test/model");
    assert.deepEqual(result.toolsUsed, ["TEST_SAFE_TOOL"]);
    assert.deepEqual(result.toolsSucceeded, []);
  });
});

test("routes a direct Composio tool to the requested connected-account alias", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830016);
  const executed: any[] = [];
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: 7, account: "work-gmail" })),
    chatResponse({ role: "assistant", content: "tool complete" }),
  ], async (slug, args, options) => {
    executed.push({ slug, args, options });
    return { ok: true };
  }, async () => {
    const result = await runAgent(830016, "read from work email", [], "test/model");
    assert.equal(result.text, "tool complete");
  });
  assert.deepEqual(executed, [{ slug: "TEST_SAFE_TOOL", args: { value: 7 }, options: { account: "work-gmail" } }]);
});

test("lists only safe connected-account metadata", async () => {
  setAgentDependenciesForTests({
    composio: {
      connectedAccounts: {
        list: async () => ({ items: [
          { id: "ca_work", alias: "work-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE", data: { access_token: "secret" } },
          { id: "ca_personal", alias: "personal-gmail", toolkit: { slug: "gmail" }, status: "ACTIVE", data: { refresh_token: "secret" } },
        ] }),
      },
    },
  });
  const accounts = await listConnectedAccounts(830016, "gmail");
  assert.deepEqual(accounts, [
    { id: "ca_work", alias: "work-gmail", toolkit: "gmail", status: "ACTIVE", createdAt: undefined, updatedAt: undefined },
    { id: "ca_personal", alias: "personal-gmail", toolkit: "gmail", status: "ACTIVE", createdAt: undefined, updatedAt: undefined },
  ]);
  assert.equal(JSON.stringify(accounts).includes("secret"), false);
});

test("materially risky tool calls stop before execution and approved exact calls execute once", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830003);
  let executions = 0;
  await withAgentMocks([toolResponse("GITHUB_DELETE_REPOSITORY", JSON.stringify({ owner: "acme", repo: "demo" }))], async () => { executions++; }, async () => {
    await assert.rejects(() => runAgent(830003, "send it", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    assert.equal(executions, 0);
    const approval = (await getSession(830003)).approvals[0];
    assert.equal(approval.toolSlug, "GITHUB_DELETE_REPOSITORY");
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(830003, approval.id, "approved"));
    await withAgentMocks([
      toolResponse("GITHUB_DELETE_REPOSITORY", JSON.stringify({ owner: "acme", repo: "demo" })),
      chatResponse({ role: "assistant", content: "sent" }),
    ], async () => { executions++; }, async () => {
      const result = await runAgent(830003, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
      assert.equal(result.text, "sent");
    });
    assert.equal(executions, 1);
  });
});

test("approved multi-tool calls execute the stored arguments when the model regenerates different JSON", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830014);
  const reviewedArgs = { tools: [{ tool_slug: "GITHUB_DELETE_REPOSITORY", arguments: { owner: "acme", repo: "demo" } }] };
  const regeneratedArgs = { tools: [{ tool_slug: "GITHUB_DELETE_REPOSITORY", arguments: { owner: "other", repo: "demo" } }] };
  const executed: any[] = [];
  await withAgentMocks([toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify(reviewedArgs))], async (slug, args) => { executed.push({ slug, args }); }, async () => {
    await assert.rejects(() => runAgent(830014, "send it", [], "test/model"), (error: unknown) => error instanceof ApprovalRequiredError);
    const approval = (await getSession(830014)).approvals[0];
    await import("../src/store.js").then(({ setApprovalStatus }) => setApprovalStatus(830014, approval.id, "approved"));
    await withAgentMocks([
      toolResponse("COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify(regeneratedArgs)),
      chatResponse({ role: "assistant", content: "sent" }),
    ], async (slug, args) => { executed.push({ slug, args }); }, async () => {
      const result = await runAgent(830014, approval.request, approval.history, approval.model, undefined, undefined, undefined, approval.id);
      assert.equal(result.text, "sent");
    }, true);
  }, true);
  assert.deepEqual(executed, [{ slug: "COMPOSIO_MULTI_EXECUTE_TOOL", args: reviewedArgs }]);
});

test("a malformed tool call is discarded without consuming the next valid tool-call budget", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830004);
  let executions = 0;
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", "not-json"),
    toolResponse("TEST_SAFE_TOOL", JSON.stringify({ value: "recovered" })),
    chatResponse({ role: "assistant", content: "recovered" }),
  ], async () => { executions++; return { ok: true }; }, async () => {
    const result = await runAgent(830004, "recover", [], "test/model", undefined, undefined, undefined, undefined, undefined, { maxToolCalls: 1 });
    assert.equal(result.text, "recovered");
    assert.equal(executions, 1);
  });
});

test("tool argument parser accepts fenced and single-quoted JSON-like objects safely", () => {
  assert.deepEqual(parseToolArguments("```json\n{'type': 'report', 'title': 'Chusky\\'s findings',}\n```"), { type: "report", title: "Chusky's findings" });
  assert.throws(() => parseToolArguments("{action: create, value: process.exit(1)}"));
});

test("tool argument parser reports truncated JSON without leaking a SyntaxError", () => {
  assert.throws(() => parseToolArguments('{"type":"report","content":"unterminated'), /malformed or truncated JSON/);
});

test("tool argument parser repairs literal newlines inside model strings", () => {
  assert.deepEqual(parseToolArguments('{"content":"line one\nline two"}'), { content: "line one\nline two" });
});

test("repeated provider tool-call IDs execute only once", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830009);
  let executions = 0;
  await withAgentMocks([
    toolResponse("TEST_SAFE_TOOL", '{"value":"one"}'),
    toolResponse("TEST_SAFE_TOOL", '{"value":"one"}'),
    chatResponse({ role: "assistant", content: "done" }),
  ], async () => { executions++; return { ok: true }; }, async () => {
    const result = await runAgent(830009, "repeat", [], "test/model");
    assert.equal(result.text, "done");
    assert.equal(executions, 1);
  });
});

test("legacy DSML tool markup is converted to a tool call and never shown to the user", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830007);
  const markup = `<|DSML|tool_calls><|DSML|invoke name="CHUCK_DAYTONA_WORKSPACE"><|DSML|parameter name="action" string="true">status</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
  const parsed = parseLegacyDsmlToolCalls(markup);
  assert.equal(parsed[0]?.function.name, "CHUCK_DAYTONA_WORKSPACE");
  assert.deepEqual(JSON.parse(parsed[0]?.function.arguments ?? "{}"), { action: "status" });
  assert.equal(cleanModelText(markup), "");
  await withAgentMocks([
    chatResponse({ role: "assistant", content: markup }),
    chatResponse({ role: "assistant", content: "workspace ready" }),
  ], async (slug, args) => ({ slug, args, status: "ready" }), async () => {
    const result = await runAgent(830007, "check my workspace", [], "test/model");
    assert.equal(result.text, "workspace ready");
    assert.deepEqual(result.toolsUsed, ["CHUCK_DAYTONA_WORKSPACE"]);
  });
});

test("full-width DSML from Composio multi-execute output is converted and hidden", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830008);
  const markup = `<｜DSML｜tool_calls><｜DSML｜invoke name="COMPOSIO_MULTI_EXECUTE_TOOL"><｜DSML｜parameter name="current_step" string="true">VERIFYING_LINKEDIN_POST</｜DSML｜parameter><｜DSML｜parameter name="current_step_metric" string="true">3/3</｜DSML｜parameter><｜DSML｜parameter name="session_id" string="true">both</｜DSML｜parameter><｜DSML｜parameter name="sync_response_to_workbench" string="false">false</｜DSML｜parameter><｜DSML｜parameter name="thought" string="true">Get the final result.</｜DSML｜parameter><｜DSML｜parameter name="tools" string="false">[{"arguments":{"taskId":"task-1","lastStepSeen":7},"tool_slug":"BROWSER_TOOL_WATCH_TASK"}]</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
  const parsed = parseLegacyDsmlToolCalls(markup);
  assert.equal(parsed[0]?.function.name, "COMPOSIO_MULTI_EXECUTE_TOOL");
  const args = JSON.parse(parsed[0]?.function.arguments ?? "{}");
  assert.equal(args.current_step, "VERIFYING_LINKEDIN_POST");
  assert.match(args.tools, /BROWSER_TOOL_WATCH_TASK/);
  assert.equal(cleanModelText(markup), "");
  await withAgentMocks([
    chatResponse({ role: "assistant", content: markup }),
    chatResponse({ role: "assistant", content: "LinkedIn verification completed." }),
  ], async (slug, receivedArgs) => ({ slug, args: receivedArgs, status: "completed" }), async () => {
    const result = await runAgent(830008, "verify the LinkedIn post", [], "test/model");
    assert.equal(result.text, "LinkedIn verification completed.");
    assert.deepEqual(result.toolsUsed, ["COMPOSIO_MULTI_EXECUTE_TOOL"]);
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

test("agent keeps the selected model when it accepts media despite incomplete metadata", async () => {
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
    assert.deepEqual(models, ["test/model"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("agent falls back only after the selected model rejects the media modality", async () => {
  await initStore({ memoryOnly: true });
  invalidateSession(830015);
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (body.model === "test/model") return new Response("No endpoints found that support image input", { status: 400 });
    return chatResponse({ role: "assistant", content: "image understood by fallback" });
  }) as typeof fetch;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "fallback-session", tools: async () => [], execute: async () => undefined }) } });
  try {
    const result = await runAgent(830015, [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }], [], "test/model");
    assert.equal(result.text, "image understood by fallback");
    // orChat retries the selected model for transient/provider failures before
    // runAgent makes the modality fallback decision.
    assert.deepEqual(models, ["test/model", "test/model", "openai/gpt-5.6-luna"]);
  } finally { globalThis.fetch = originalFetch; }
});
