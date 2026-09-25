import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { config } from "../src/config.js";
import { persistSdkCompanyRun, registerSdkApi, sdkRunArtifacts, setOrganizationAccessResolverForTests, setSdkTaskWorkflowEnqueuerForTests, setWebAuthSessionResolverForTests } from "../src/sdkApi.js";
import { setAgentDependenciesForTests } from "../src/agent.js";
import { setPhoneCallLauncherForTests } from "../src/nativeTools.js";
import { daytonaEngine } from "../src/lib/daytona/engine.js";
import { addRecallMeeting, authenticateCliToken, createApproval, createCliDevice, createTriggerEvent, createWebTelegramLinkCode, enqueueOutbox, getOutbox, getSession, getTask, initStore, redeemWebTelegramLinkCode, saveCalendarMeetingPreparation, saveSession, updateOutbox, upsertMeetingContact, upsertMemory } from "../src/store.js";
import { redeemLinkCode } from "../src/channels/identity.js";

beforeEach(async () => {
  (config as { apiKey: string }).apiKey = "sdk-test-key";
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = false;
  setWebAuthSessionResolverForTests();
  setOrganizationAccessResolverForTests();
  setSdkTaskWorkflowEnqueuerForTests();
  await initStore({ memoryOnly: true });
  setPhoneCallLauncherForTests(async (userId, input) => ({ id: `twc_test_${userId}`, userId, provider: "twilio", direction: "outbound", callProfile: input.callProfile, phoneNumber: input.phoneNumber, purpose: input.purpose, status: "bridging", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }));
});

afterEach(() => setPhoneCallLauncherForTests());

function app(): Hono { const value = new Hono(); registerSdkApi(value); return value; }
function request(body: unknown, key = "idem_1") { return new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }); }

test("native tool discovery returns executable JSON schemas for all reliability capabilities", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tool-catalog-owner" };
  const reliability = ["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_FILE_BRIDGE", "CHUCK_MEDIA_BRIDGE", "CHUCK_TOOL_RECOVERY"];
  for (const slug of reliability) {
    const listed = await api.fetch(new Request(`http://local/v1/tools?source=native&query=${encodeURIComponent(slug)}`, { headers }));
    assert.equal(listed.status, 200);
    const data = (await listed.json() as { data: Array<{ slug: string; parameters?: { type?: string }; execution?: string }> }).data;
    const item = data.find((candidate) => candidate.slug === slug);
    assert.ok(item, `${slug} is discoverable`);
    assert.equal(item.parameters?.type, "object");
    assert.equal(item.execution, "durable_run");
    const detail = await api.fetch(new Request(`http://local/v1/tools/${slug}`, { headers }));
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { parameters?: { type?: string } }).parameters?.type, "object");
  }
});

test("operator reliability surfaces are owner-scoped and expose honest provider proof", async () => {
  const api = app();
  const ownerHeaders = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "operator-owner" };
  const sample = await api.fetch(new Request("http://local/v1/operator/reliability/sample", { method: "POST", headers: { ...ownerHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "operator.test", status: "success", latencyMs: 12 }) }));
  assert.equal(sample.status, 201);
  const health = await api.fetch(new Request("http://local/v1/operator/reliability?operation=operator.test", { headers: ownerHeaders }));
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { data: { sampleCount: number } }).data.sampleCount, 1);
  const matrix = await api.fetch(new Request("http://local/v1/operator/provider-matrix", { headers: ownerHeaders }));
  assert.equal(matrix.status, 200);
  assert.match(JSON.stringify(await matrix.json()), /configured_unverified|not_configured/);
  const other = await api.fetch(new Request("http://local/v1/operator/reliability?operation=operator.test", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "operator-other" } }));
  assert.equal((await other.json() as { data: { sampleCount: number } }).data.sampleCount, 0);
});

test("custom MCP catalogue entries remain scoped to the authenticated SDK identity", async () => {
  const externalId = "mcp-catalog-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const owner = await getSession(userId);
  owner.mcpConnections = [{ serverId: "custom-test-server", customServer: { name: "Owner MCP", url: "https://mcp.example.test/mcp", auth: "none", requireApproval: true }, enabled: true, createdAt: Date.now(), updatedAt: Date.now() }];
  await saveSession(userId, owner);
  const api = app();
  const ownerResponse = await api.fetch(new Request("http://local/v1/mcp/catalog", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId } }));
  const otherResponse = await api.fetch(new Request("http://local/v1/mcp/catalog", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "mcp-other-user" } }));
  assert.equal(ownerResponse.status, 200);
  assert.equal(otherResponse.status, 200);
  const ownerCustom = ((await ownerResponse.json()) as { data: Array<{ id: string; custom?: boolean }> }).data.filter((item) => item.custom);
  const otherCustom = ((await otherResponse.json()) as { data: Array<{ id: string; custom?: boolean }> }).data.filter((item) => item.custom);
  assert.deepEqual(ownerCustom.map((item) => item.id), ["custom-test-server"]);
  assert.deepEqual(otherCustom, []);
});

test("custom MCP API rejects incomplete configuration before network access", async () => {
  const api = app();
  const response = await api.fetch(new Request("http://local/v1/mcp/custom-servers", { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "mcp-invalid-owner", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Missing URL" }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_custom_mcp_server");
});

test("owner can confirm an ambiguous channel delivery only after checking the destination", async () => {
  const externalId = "delivery-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const record = await enqueueOutbox({ idempotencyKey: "delivery-ambiguous-1", accountId: `sdk:${userId}`, userId, provider: "slack", conversationId: "D1", text: "possibly delivered", kind: "message" });
  await updateOutbox(record.id, { status: "ambiguous", lastError: "Check provider." });
  const api = app();
  const ownerHeaders = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId };
  const confirmed = await api.fetch(new Request(`http://local/v1/deliveries/${record.id}/confirm-delivered`, { method: "POST", headers: ownerHeaders }));
  assert.equal(confirmed.status, 200);
  const confirmation = await confirmed.json() as { status: string; providerStatus: string; durationMs?: number };
  assert.equal(confirmation.status, "delivered");
  assert.equal(confirmation.providerStatus, "owner_confirmed_delivered");
  assert.ok(typeof confirmation.durationMs === "number");
  assert.equal((await getOutbox(record.id))?.providerStatus, "owner_confirmed_delivered");

  const replay = await api.fetch(new Request(`http://local/v1/deliveries/${record.id}/confirm-delivered`, { method: "POST", headers: ownerHeaders }));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, record.id);

  const other = await api.fetch(new Request(`http://local/v1/deliveries/${record.id}/confirm-delivered`, { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "someone-else" } }));
  assert.equal(other.status, 404);
});

test("delivery confirmation cannot hide a record that is not ambiguous", async () => {
  const externalId = "delivery-still-running-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const record = await enqueueOutbox({ idempotencyKey: "delivery-queued-1", accountId: `sdk:${userId}`, userId, provider: "slack", conversationId: "D1", text: "not sent yet", kind: "message" });
  const api = app();
  const response = await api.fetch(new Request(`http://local/v1/deliveries/${record.id}/confirm-delivered`, { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId } }));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "delivery_not_ambiguous");
});

test("SDK run artifacts expose downloadable metadata without workspace paths or bytes", () => {
  const artifacts = sdkRunArtifacts([{ artifactId: "artifact_pdf_1", name: "proposal.pdf", contentType: "application/pdf", type: "pdf", data: Buffer.from("pdf-bytes") }]);
  assert.deepEqual(artifacts, [{ id: "artifact_pdf_1", name: "proposal.pdf", type: "pdf", contentType: "application/pdf", size: 9 }]);
  assert.equal("data" in (artifacts?.[0] ?? {}), false);
  assert.equal("path" in (artifacts?.[0] ?? {}), false);
});

test("SDK artifact download returns the owner-scoped binary with download headers", async () => {
  const originalStreamArtifact = daytonaEngine.streamArtifact;
  let receivedUserId: number | undefined;
  (daytonaEngine as any).streamArtifact = async (userId: number, id: string) => {
    receivedUserId = userId;
    assert.equal(id, "artifact_pdf_1");
    return { id, name: "proposal.pdf", type: "pdf", contentType: "application/pdf", size: 9, data: Buffer.alloc(0), stream: Readable.from([Buffer.from("pdf-bytes")]) };
  };
  try {
    const response = await app().fetch(new Request("http://local/v1/artifacts/artifact_pdf_1/download", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "download-owner" } }));
    assert.equal(response.status, 200);
    assert.equal(typeof receivedUserId, "number");
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="proposal.pdf"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from("pdf-bytes"));
  } finally {
    (daytonaEngine as any).streamArtifact = originalStreamArtifact;
  }
});

test("SDK thread creation is authenticated, replay-safe, and rejects key/body mismatches", async () => {
  const api = app();
  const first = await api.fetch(request({ metadata: { source: "test" } }));
  assert.equal(first.status, 201); const created = await first.json() as { id: string };
  const replay = await api.fetch(request({ metadata: { source: "test" } }));
  assert.equal(replay.status, 201); assert.equal((await replay.json() as { id: string }).id, created.id);
  const mismatch = await api.fetch(request({ metadata: { source: "changed" } }));
  assert.equal(mismatch.status, 409); const mismatchBody = await mismatch.json() as { error: { code: string; requestId: string } }; assert.equal(mismatchBody.error.code, "idempotency_mismatch"); assert.equal(mismatch.headers.get("x-request-id"), mismatchBody.error.requestId);
  const forbidden = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { "X-Chusky-User-Id": "tenant-user" } }));
  assert.equal(forbidden.status, 401);
});

test("SDK run streams the same human-readable tool progress used by Telegram", async () => {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "status-session", tools: async () => [] }) } });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("openrouter.ai")) return new Response("offline", { status: 503 });
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    chatCalls += 1;
    const chunks = chatCalls === 1
      ? [{ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_search_skills", type: "function", function: { name: "CHUCK_SEARCH_SKILLS", arguments: JSON.stringify({ query: "sales" }) } }] }, finish_reason: "tool_calls" }] }]
      : [{ choices: [{ delta: { role: "assistant", content: "Done." }, finish_reason: "stop" }] }];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const api = app();
    const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "status-owner", "Content-Type": "application/json", "Idempotency-Key": "status-thread" }, body: JSON.stringify({}) }));
    const thread = await created.json() as { id: string };
    const response = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/stream`, { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "status-owner", "Content-Type": "application/json" }, body: JSON.stringify({ input: "Find the relevant sales guidance." }) }));
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; text?: string; id?: string; at?: number; toolSlug?: string; status?: string; message?: string; summary?: string; durationMs?: number; arguments?: unknown; result?: unknown });
    assert.equal(events.some((item) => item.type === "run.status" && item.text === "🧭 I’m bringing in the relevant guidance…"), true);
    assert.equal(events.some((item) => item.type === "run.completed"), true);
    const activity = events.filter((item) => item.type === "run.tool_activity");
    assert.deepEqual(activity.map((item) => item.status), ["started", "completed"]);
    assert.equal(activity[0].toolSlug, "CHUCK_SEARCH_SKILLS");
    assert.equal(activity[0].message, "🧭 I’m bringing in the relevant guidance…");
    assert.ok((activity[1].durationMs ?? 0) >= 0);
    assert.match(activity[1].summary ?? "", /returned/);
    assert.equal(activity.some((item) => "arguments" in item || "result" in item), false);
    const persistedResponse = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs`, { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "status-owner" } }));
    const persisted = await persistedResponse.json() as { data: Array<{ events: Array<{ type: string; status?: string }> }> };
    assert.equal(persisted.data[0].events.filter((item) => item.type === "run.tool_activity").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("denying a run approval preserves its recorded tool steps after reload", async () => {
  const externalId = "approval-denial-timeline-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId, "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { ...headers, "Idempotency-Key": "approval-denial-thread" }, body: JSON.stringify({}) }));
  const threadView = await created.json() as { id: string };
  const approval = await createApproval({ userId, toolSlug: "CHUCK_SEARCH_SKILLS", args: { query: "sales" }, request: "Search the relevant guidance.", history: [], model: "openai/gpt-luna-latest" });
  const session = await getSession(userId);
  const thread = session.sdkThreads!.find((item) => item.id === threadView.id)!;
  thread.runs.push({
    id: "run_denied_timeline", status: "requires_approval", input: "Search the relevant guidance.", approvalId: approval.id,
    events: [
      { id: "event_before_approval", type: "run.tool_activity", at: 1, toolSlug: "CHUCK_SEARCH_SKILLS", status: "completed", message: "Guidance searched", summary: "Found relevant material" },
    ], createdAt: 1, updatedAt: 1,
  });
  await saveSession(userId, session);

  const denied = await api.fetch(new Request(`http://local/v1/approvals/${approval.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) }));
  assert.equal(denied.status, 200);
  const persisted = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/run_denied_timeline`, { headers }));
  const run = await persisted.json() as { status: string; events: Array<{ id: string; type: string; text?: string }> };
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.some((event) => event.id === "event_before_approval"), true);
  assert.match(run.events.at(-1)?.text ?? "", /Approval denied/);
});

test("cancelling a run keeps its already-recorded tool timeline", async () => {
  const externalId = "run-cancellation-timeline-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId, "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { ...headers, "Idempotency-Key": "cancel-timeline-thread" }, body: JSON.stringify({}) }));
  const thread = await created.json() as { id: string };
  const session = await getSession(userId);
  session.sdkThreads!.find((item) => item.id === thread.id)!.runs.push({
    id: "run_cancelled_timeline", status: "running", input: "Prepare the report.",
    events: [{ id: "event_before_cancel", type: "run.tool_activity", at: 1, toolSlug: "CHUCK_SEARCH_SKILLS", status: "completed", message: "Research complete", summary: "Sources found" }],
    createdAt: 1, updatedAt: 1,
  });
  await saveSession(userId, session);

  const cancelled = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/run_cancelled_timeline/cancel`, { method: "POST", headers }));
  assert.equal(cancelled.status, 200);
  const persisted = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/run_cancelled_timeline`, { headers }));
  const run = await persisted.json() as { status: string; events: Array<{ id: string }> };
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.some((event) => event.id === "event_before_cancel"), true);
});

test("approved run stays visible while resuming and preserves its earlier steps", async () => {
  const originalFetch = globalThis.fetch;
  const externalId = "approval-resume-timeline-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  let markAgentCallStarted!: () => void;
  let finishAgentCall!: () => void;
  const agentCallStarted = new Promise<void>((resolve) => { markAgentCallStarted = resolve; });
  const agentCallGate = new Promise<void>((resolve) => { finishAgentCall = resolve; });
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "approval-resume-session", tools: async () => [] }) } });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("openrouter.ai")) return new Response("offline", { status: 503 });
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    markAgentCallStarted();
    await agentCallGate;
    const final = { choices: [{ message: { role: "assistant", content: "Approval resumed successfully." }, finish_reason: "stop" }] };
    return new Response(JSON.stringify(final), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const api = app();
    const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId, "Content-Type": "application/json" };
    const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { ...headers, "Idempotency-Key": "approval-resume-thread" }, body: JSON.stringify({}) }));
    const thread = await created.json() as { id: string };
    const approval = await createApproval({ userId, toolSlug: "CHUCK_SEARCH_SKILLS", args: { query: "sales" }, request: "Search the relevant guidance.", history: [], model: "openai/gpt-luna-latest" });
    const session = await getSession(userId);
    session.sdkThreads!.find((item) => item.id === thread.id)!.runs.push({
      id: "run_approved_timeline", status: "requires_approval", input: "Search the relevant guidance.", approvalId: approval.id,
      events: [{ id: "event_original_step", type: "run.tool_activity", at: 1, toolSlug: "CHUCK_SEARCH_SKILLS", status: "completed", message: "Earlier research step", summary: "Sources found" }],
      createdAt: 1, updatedAt: 1,
    });
    await saveSession(userId, session);

    const decisionPromise = api.fetch(new Request(`http://local/v1/approvals/${approval.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) }));
    await agentCallStarted;
    const inProgressResponse = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/run_approved_timeline`, { headers }));
    const inProgress = await inProgressResponse.json() as { status: string; events: Array<{ id: string; type: string; status?: string }> };
    assert.equal(inProgress.status, "running");
    assert.equal(inProgress.events.some((event) => event.id === "event_original_step"), true);
    assert.equal(inProgress.events.some((event) => event.type === "run.started"), true);

    finishAgentCall();
    const decision = await decisionPromise;
    assert.equal(decision.status, 200);
    const finalResponse = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/run_approved_timeline`, { headers }));
    const finalRun = await finalResponse.json() as { status: string; output?: string; events: Array<{ id: string }> };
    assert.equal(finalRun.status, "completed", JSON.stringify(finalRun));
    assert.equal(finalRun.events.some((event) => event.id === "event_original_step"), true);
    assert.match(finalRun.output ?? "", /Approval resumed successfully\.$/);
  } finally {
    finishAgentCall();
    globalThis.fetch = originalFetch;
  }
});

test("SDK tool activity survives a disconnected stream while the same run keeps working", async () => {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  let markSecondCallStarted!: () => void;
  let finishSecondCall!: () => void;
  const secondCallStarted = new Promise<void>((resolve) => { markSecondCallStarted = resolve; });
  const secondCallGate = new Promise<void>((resolve) => { finishSecondCall = resolve; });
  setAgentDependenciesForTests({ composio: { create: async () => ({ sessionId: "refresh-session", tools: async () => [] }) } });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("openrouter.ai")) return new Response("offline", { status: 503 });
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["text"] }, supported_parameters: { tools: true } } }), { status: 200 });
    chatCalls += 1;
    if (chatCalls === 1) {
      const chunk = { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_refresh_search", type: "function", function: { name: "CHUCK_SEARCH_SKILLS", arguments: JSON.stringify({ query: "sales" }) } }] }, finish_reason: "tool_calls" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    markSecondCallStarted();
    await secondCallGate;
    const final = { choices: [{ delta: { role: "assistant", content: "Finished after reconnect." }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const api = app();
    const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "refresh-owner", "Content-Type": "application/json" };
    const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { ...headers, "Idempotency-Key": "refresh-thread" }, body: JSON.stringify({}) }));
    const thread = await created.json() as { id: string };
    const requestAbort = new AbortController();
    const response = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/stream`, { method: "POST", headers, body: JSON.stringify({ input: "Search and finish the task." }), signal: requestAbort.signal }));
    assert.equal(response.status, 200);
    await secondCallStarted;

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    requestAbort.abort();

    const during = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs`, { headers }));
    const active = (await during.json() as { data: Array<{ id: string; status: string; events: Array<{ type: string; status?: string }> }> }).data[0];
    assert.equal(active.status, "running");
    assert.deepEqual(active.events.filter((item) => item.type === "run.tool_activity").map((item) => item.status), ["started", "completed"]);

    finishSecondCall();
    let settled: { status: string; output?: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const latest = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs/${active.id}`, { headers }));
      settled = await latest.json() as { status: string; output?: string };
      if (settled.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(settled?.status, "completed");
    assert.match(settled?.output ?? "", /Finished after reconnect\.$/);
  } finally {
    finishSecondCall();
    globalThis.fetch = originalFetch;
  }
});

test("SDK autonomous missions are idempotent, owner-scoped, and controllable", async () => {
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-mission-test");
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "mission-owner", "Content-Type": "application/json", "Idempotency-Key": "mission-request-1" };
  const body = JSON.stringify({ title: "Verify launch brief", objective: "Research and verify the launch brief.", definitionOfDone: "Every required claim has a source and the brief is ready.", steps: [{ id: "research", title: "Research", objective: "Collect verified sources." }, { id: "draft", title: "Draft", objective: "Write the brief.", dependsOn: ["research"] }] });
  const first = await api.fetch(new Request("http://local/v1/missions", { method: "POST", headers, body }));
  assert.equal(first.status, 201);
  const created = await first.json() as { id: string; status: string; rootTaskId?: string };
  assert.equal(created.status, "running");
  assert.ok(created.rootTaskId);
  const replay = await api.fetch(new Request("http://local/v1/missions", { method: "POST", headers, body }));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, created.id);
  const hidden = await api.fetch(new Request(`http://local/v1/missions/${created.id}`, { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "another-owner" } }));
  assert.equal(hidden.status, 404);
  const paused = await api.fetch(new Request(`http://local/v1/missions/${created.id}/pause`, { method: "POST", headers }));
  assert.equal(paused.status, 200);
  assert.equal((await paused.json() as { status: string }).status, "paused");
  const resumed = await api.fetch(new Request(`http://local/v1/missions/${created.id}/resume`, { method: "POST", headers }));
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json() as { status: string }).status, "running");
  const step = await api.fetch(new Request(`http://local/v1/missions/${created.id}/steps/research/complete`, { method: "POST", headers, body: JSON.stringify({ result: "Sources verified." }) }));
  assert.equal(step.status, 200);
  assert.equal((await step.json() as { currentStepId?: string }).currentStepId, "draft");
  const replanned = await api.fetch(new Request(`http://local/v1/missions/${created.id}/replan`, { method: "POST", headers, body: JSON.stringify({ reason: "Add an explicit review gate.", steps: [{ id: "research", title: "Research", objective: "Collect verified sources." }, { id: "draft", title: "Draft", objective: "Write the brief.", dependsOn: ["research"] }, { id: "review", title: "Review", objective: "Review the brief.", dependsOn: ["draft"] }] }) }));
  assert.equal(replanned.status, 200);
  assert.equal((await replanned.json() as { steps: Array<{ id: string; status: string }> }).steps.find((item) => item.id === "research")?.status, "completed");
  const cancelled = await api.fetch(new Request(`http://local/v1/missions/${created.id}/cancel`, { method: "POST", headers }));
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
});

test("context, outcome, evidence, and A2A surfaces share the same owner-scoped runtime", async () => {
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-a2a-test");
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "a2a-owner", "Content-Type": "application/json" };
  const context = await api.fetch(new Request("http://local/v1/context", { method: "POST", headers, body: JSON.stringify({ scope: "department", scopeId: "sales", kind: "decision", key: "ICP", value: "Fintech", sensitivity: "normal" }) }));
  assert.equal(context.status, 201);
  const selected = await api.fetch(new Request("http://local/v1/context?purpose=sales", { headers }));
  assert.match(await selected.text(), /Fintech/);
  const outcomes = await api.fetch(new Request("http://local/v1/outcomes", { headers }));
  assert.equal(outcomes.status, 200); assert.ok(((await outcomes.json()) as { data: unknown[] }).data.length >= 7);
  const card = await api.fetch(new Request("http://local/a2a/.well-known/agent-card.json"));
  assert.equal(card.status, 200); assert.match(await card.text(), /Outcome Runtime/);
  const task = await api.fetch(new Request("http://local/a2a/tasks", { method: "POST", headers, body: JSON.stringify({ outcome: "competitor-change-report", input: { "competitor list": "Acme", "monitoring topics": "pricing", "report cadence": "weekly" } }) }));
  assert.equal(task.status, 202);
  const created = await task.json() as { id: string; status: string };
  assert.equal(created.status, "working");
  const status = await api.fetch(new Request(`http://local/a2a/tasks/${created.id}`, { headers }));
  assert.equal(status.status, 200);
  const forbidden = await api.fetch(new Request(`http://local/a2a/tasks/${created.id}`, { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "other-owner" } }));
  assert.equal(forbidden.status, 404);
});

test("A2A JSON-RPC exposes standard task operations over the owner-scoped mission runtime", async () => {
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-a2a-rpc-test");
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "a2a-rpc-owner", "Content-Type": "application/a2a+json", "Idempotency-Key": "a2a-rpc-create" };
  const card = await api.fetch(new Request("http://local/a2a/.well-known/agent-card.json"));
  assert.equal(card.status, 200);
  const rootCard = await api.fetch(new Request("http://local/.well-known/agent-card.json"));
  assert.equal(rootCard.status, 200);
  assert.equal(rootCard.headers.get("a2a-version"), "1.0");
  const cardBody = await card.json() as { protocolVersion: string; supportedInterfaces: Array<{ protocolBinding: string; url: string }>; skills: Array<{ id: string; examples?: string[]; inputModes?: string[] }> };
  assert.equal(cardBody.protocolVersion, "1.0");
  assert.equal(cardBody.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
  assert.match(cardBody.supportedInterfaces[0]?.url ?? "", /\/a2a\/rpc$/);
  assert.equal((cardBody as { capabilities?: { pushNotifications?: boolean } }).capabilities?.pushNotifications, true);
  for (const slug of ["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_FILE_BRIDGE", "CHUCK_MEDIA_BRIDGE", "CHUCK_TOOL_RECOVERY"]) {
    const skill = cardBody.skills.find((item) => item.id === slug);
    assert.ok(skill, `${slug} is advertised as an A2A skill`);
    assert.ok(skill.examples?.length);
    if (slug === "CHUCK_MEDIA_BRIDGE") assert.ok(skill.inputModes?.includes("application/json"));
  }

  const send = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "A2A-Version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: "send-1", method: "message/send", params: { contextId: "crm-release-context", message: { role: "ROLE_USER", messageId: "msg-1", parts: [{ text: "Prepare a verified launch brief." }] } } }) }));
  assert.equal(send.status, 200);
  const created = await send.json() as { result: { task: { id: string; status: { state: string } } } };
  assert.match(created.result.task.id, /^mis_/);
  assert.equal(created.result.task.status.state, "TASK_STATE_WORKING");
  assert.equal(created.result.task.contextId, "crm-release-context");

  const get = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "Idempotency-Key": "a2a-rpc-get" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: created.result.task.id } }) }));
  assert.equal(get.status, 200);
  assert.equal(((await get.json()) as { result: { id: string } }).result.id, created.result.task.id);

  const list = await api.fetch(new Request("http://local/a2a/v1", { method: "POST", headers: { ...headers, "Idempotency-Key": "a2a-rpc-list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ListTasks", params: { pageSize: 10 } }) }));
  assert.equal(list.status, 200);
  const listed = await list.json() as { result: { tasks: Array<{ id: string }>; nextPageToken: string } };
  assert.equal(listed.result.tasks.some((item) => item.id === created.result.task.id), true);
  assert.equal(typeof listed.result.nextPageToken, "string");

  const cancelled = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "Idempotency-Key": "a2a-rpc-cancel" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: created.result.task.id } }) }));
  assert.equal(cancelled.status, 200);
  assert.equal(((await cancelled.json()) as { result: { status: { state: string } } }).result.status.state, "TASK_STATE_CANCELED");

  const malformed = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "Idempotency-Key": "a2a-rpc-invalid" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "NotA2AMethod", params: {} }) }));
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32601);

  const unsupportedVersion = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "A2A-Version": "9.9" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tasks/get", params: { id: created.result.task.id } }) }));
  assert.equal(unsupportedVersion.status, 400);
  assert.equal(((await unsupportedVersion.json()) as { error: { code: string } }).error.code, "a2a_version_not_supported");
});

test("A2A tasks accept only verified owner image file IDs and persist them for durable worker input", async () => {
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-a2a-image-test");
  const externalId = "a2a-image-owner";
  const userId = Number.parseInt(createHash("sha256").update(`sdk:root:${externalId}`).digest("hex").slice(0, 12), 16);
  const session = await getSession(userId);
  session.sdkFiles = [
    { id: "file_a2a_image", key: `sdk/${userId}/image.png`, name: "campaign.png", contentType: "image/png", size: 64, status: "available", createdAt: Date.now() },
    { id: "file_a2a_text", key: `sdk/${userId}/notes.txt`, name: "notes.txt", contentType: "text/plain", size: 12, status: "available", createdAt: Date.now() },
  ];
  await saveSession(userId, session);
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": externalId, "Content-Type": "application/a2a+json", "Idempotency-Key": "a2a-image-task-123" };
  const send = async (fileId: string, idempotencyKey: string) => api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers: { ...headers, "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ jsonrpc: "2.0", id: "image-send", method: "message/send", params: { message: { role: "ROLE_USER", parts: [{ text: "Transfer this image to the connected social account." }, { data: { chuskyFileIds: [fileId] } }] } } }) }));

  const response = await send("file_a2a_image", "a2a-image-valid-123");
  assert.equal(response.status, 200);
  const task = (await response.json() as { result: { task: { id: string } } }).result.task;
  const mission = await import("../src/store.js").then(({ getMission }) => getMission(userId, task.id));
  assert.ok(mission?.rootTaskId);
  const rootTask = await getTask(userId, mission.rootTaskId!);
  assert.deepEqual(rootTask?.sdkAttachments?.map(({ id }) => id), ["file_a2a_image"]);

  const invalid = await send("file_a2a_text", "a2a-image-invalid-123");
  assert.equal(invalid.status, 400);
  assert.match(JSON.stringify(await invalid.json()), /verified image/i);
  const otherOwner = await getSession(userId + 1);
  otherOwner.sdkFiles = [{ id: "file_a2a_foreign", key: `sdk/${userId + 1}/foreign.png`, name: "foreign.png", contentType: "image/png", size: 64, status: "available", createdAt: Date.now() }];
  await saveSession(userId + 1, otherOwner);
  const foreign = await send("file_a2a_foreign", "a2a-image-foreign-123");
  assert.equal(foreign.status, 400);
  assert.match(JSON.stringify(await foreign.json()), /verified image/i);
});

test("A2A push notification configurations are encrypted, owner-scoped, and manageable", async () => {
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-a2a-push-test");
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "a2a-push-owner", "Content-Type": "application/a2a+json" };
  const send = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "push-send", method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "Prepare a callback-enabled task." }] }, configuration: { pushNotificationConfig: { url: "https://agent.example.test/chusky", token: "secret-token", authentication: { scheme: "Bearer", credentials: "agent-credential" } } } } }) }));
  assert.equal(send.status, 200);
  const task = (await send.json() as { result: { task: { id: string } } }).result.task;
  const list = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "push-list", method: "ListTaskPushNotificationConfigs", params: { taskId: task.id } }) }));
  const configs = (await list.json() as { result: { configs: Array<{ id: string; url: string; token?: string; authentication?: { credentials?: string } }> } }).result.configs;
  assert.equal(configs.length, 1);
  assert.equal(configs[0]?.url, "https://agent.example.test/chusky");
  assert.equal("token" in (configs[0] ?? {}), false);
  assert.equal("credentials" in (configs[0]?.authentication ?? {}), false);
  const get = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "push-get", method: "GetTaskPushNotificationConfig", params: { taskId: task.id, configId: configs[0]?.id } }) }));
  assert.equal(get.status, 200);
  const remove = await api.fetch(new Request("http://local/a2a/rpc", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "push-delete", method: "DeleteTaskPushNotificationConfig", params: { taskId: task.id, configId: configs[0]?.id } }) }));
  assert.equal(remove.status, 200);
});

test("SDK conversation lifecycle is owned, archive-aware, and protects active runs", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "lifecycle-user", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: JSON.stringify({ metadata: { title: "Original" } }) }));
  assert.equal(created.status, 201);
  const thread = await created.json() as { id: string; metadata: Record<string, unknown> };
  const renamed = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "Renamed" }) }));
  assert.equal(renamed.status, 200); assert.equal((await renamed.json() as typeof thread).metadata.title, "Renamed");
  const archived = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ archived: true }) }));
  assert.equal(archived.status, 200);
  const activeThreads = await api.fetch(new Request("http://local/v1/threads", { headers }));
  assert.equal((await activeThreads.json() as { data: unknown[] }).data.length, 0);
  const allThreads = await api.fetch(new Request("http://local/v1/threads?includeArchived=true", { headers }));
  assert.equal((await allThreads.json() as { data: unknown[] }).data.length, 1);
  const invalid = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "x".repeat(121) }) }));
  assert.equal(invalid.status, 400);
  const deleted = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "DELETE", headers }));
  assert.equal(deleted.status, 204);
  const missing = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "DELETE", headers }));
  assert.equal(missing.status, 404);
});

test("SDK file intents enforce the configured allowlist and maximum size before storage access", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/files", { method: "POST", headers, body: JSON.stringify({ name: "unsafe.exe", contentType: "application/x-msdownload", size: 10 }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_file");
});

test("SDK trigger catalogue rejects malformed toolkit route parameters before provider access", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user" };
  const response = await api.fetch(new Request("http://local/v1/triggers/catalog/toolkits/not%20a%20toolkit", { headers }));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_toolkit");
});

test("SDK webhook creation replays the same subscription on a lost response", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json", "Idempotency-Key": "webhook_once" };
  const create = () => new Request("http://local/v1/webhooks", { method: "POST", headers, body: JSON.stringify({ url: "https://hooks.example.test/chusky" }) });
  const first = await api.fetch(create());
  assert.equal(first.status, 201); const created = await first.json() as { id: string; secret: string };
  const replay = await api.fetch(create());
  assert.equal(replay.status, 201); const replayed = await replay.json() as { id: string; secret: string };
  assert.deepEqual(replayed, created);
  const list = await api.fetch(new Request("http://local/v1/webhooks", { headers }));
  assert.equal((await list.json() as { data: unknown[] }).data.length, 1);
  const remove = await api.fetch(new Request(`http://local/v1/webhooks/${created.id}`, { method: "DELETE", headers }));
  assert.equal(remove.status, 204);
  const empty = await api.fetch(new Request("http://local/v1/webhooks", { headers }));
  assert.equal((await empty.json() as { data: unknown[] }).data.length, 0);
});

test("root key provisions hash-only project keys with isolated SDK users and revocation", async () => {
  const api = app();
  const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  const provision = await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Acme" }) }));
  assert.equal(provision.status, 201); const project = await provision.json() as { id: string; key: string };
  assert.equal((await getSession(0)).sdkAudit?.some((entry) => entry.action === "POST /v1/admin/projects" && entry.status === 201), true);
  const adminAudit = await api.fetch(new Request("http://local/v1/admin/audit-events", { headers: root }));
  assert.equal((await adminAudit.json() as { data: Array<{ action: string }> }).data.some((entry) => entry.action === "POST /v1/admin/projects"), true);
  const headers = { Authorization: `Bearer ${project.key}`, "X-Chusky-User-Id": "shared-user", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(created.status, 201);
  const restrict = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}`, { method: "PATCH", headers: root, body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(restrict.status, 200);
  const nowDenied = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(nowDenied.status, 403);
  const rotatedResponse = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}/rotate-key`, { method: "POST", headers: root, body: "{}" }));
  assert.equal(rotatedResponse.status, 201); const rotated = await rotatedResponse.json() as { key: string };
  const stale = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(stale.status, 401);
  const newHeaders = { ...headers, Authorization: `Bearer ${rotated.key}` };
  const fresh = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: newHeaders, body: "{}" }));
  assert.equal(fresh.status, 403);
  const revoke = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}`, { method: "DELETE", headers: root }));
  assert.equal(revoke.status, 204);
  const denied = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: newHeaders, body: "{}" }));
  assert.equal(denied.status, 401);
  const projects = await api.fetch(new Request("http://local/v1/admin/projects", { headers: root }));
  assert.equal(JSON.stringify(await projects.json()).includes(project.key), false);
});

test("root-only admin routes never require an SDK end-user header", async () => {
  const api = app();
  const response = await api.fetch(new Request("https://local.test/v1/admin/projects", { headers: { Authorization: "Bearer sdk-test-key" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
});

test("project scopes are enforced at the v1 boundary", async () => {
  const api = app(); const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  const provision = await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Read only", scopes: ["threads:read"] }) }));
  const project = await provision.json() as { key: string };
  const headers = { Authorization: `Bearer ${project.key}`, "X-Chusky-User-Id": "customer", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "insufficient_scope");
});

test("verified dashboard users can only manage their own bounded project keys", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => {
    const id = headers.get("x-test-web-user");
    return id ? { user: { id, emailVerified: headers.get("x-test-verified") !== "false" } } : null;
  });
  const api = app();
  const web = (user: string, path: string, init: RequestInit = {}) => new Request(`http://local/v1${path}`, {
    ...init,
    headers: { "X-Test-Web-User": user, "X-Test-Verified": "true", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  const unauthenticated = await api.fetch(new Request("http://local/v1/account/projects"));
  assert.equal(unauthenticated.status, 401);
  const unverified = await api.fetch(web("unverified", "/account/projects", { method: "POST", headers: { "X-Test-Verified": "false" }, body: JSON.stringify({ name: "Nope" }) }));
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json() as { error: { code: string } }).error.code, "email_verification_required");

  const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Operator only" }) }));
  const create = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Production" }) }));
  assert.equal(create.status, 201);
  const created = await create.json() as { id: string; key: string; keyPrefix: string; scopes: string[] };
  const browserHeaderSpoof = await api.fetch(web("alice", "/threads", { method: "POST", headers: { "X-Chusky-User-Id": "bob" }, body: "{}" }));
  assert.equal(browserHeaderSpoof.status, 201);
  assert.equal((await browserHeaderSpoof.json() as { externalId: string }).externalId, "alice");
  assert.match(created.key, /^chsk_/);
  assert.deepEqual(created.scopes, ["*"]);
  const control = await getSession(0);
  const stored = control.sdkProjects!.find((project) => project.id === created.id)!;
  assert.equal(stored.ownerWebAuthUserId, "alice");
  assert.notEqual(stored.keyHash, created.key);
  assert.equal(JSON.stringify(await api.fetch(web("alice", "/account/projects")).then((response) => response.json())).includes(created.key), false);
  assert.deepEqual((await api.fetch(web("bob", "/account/projects")).then((response) => response.json()) as { data: unknown[] }).data, []);

  const otherUser = await api.fetch(web("bob", `/account/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(otherUser.status, 404);
  const invalidScopes = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Invalid", scopes: ["admin:write"] }) }));
  assert.equal(invalidScopes.status, 400);
  const update = await api.fetch(web("alice", `/account/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(update.status, 200);
  const rotatedResponse = await api.fetch(web("alice", `/account/projects/${created.id}/rotate-key`, { method: "POST" }));
  assert.equal(rotatedResponse.status, 201);
  const rotated = await rotatedResponse.json() as { key: string };
  const stale = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: `Bearer ${created.key}`, "X-Chusky-User-Id": "customer" }, body: "{}" }));
  assert.equal(stale.status, 401);
  const revoke = await api.fetch(web("alice", `/account/projects/${created.id}`, { method: "DELETE" }));
  assert.equal(revoke.status, 204);
  const revoked = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: `Bearer ${rotated.key}`, "X-Chusky-User-Id": "customer" }, body: "{}" }));
  assert.equal(revoked.status, 401);

  for (let index = 0; index < 10; index += 1) {
    const response = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: `Key ${index}` }) }));
    assert.equal(response.status, 201);
  }
  const overLimit = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Too many" }) }));
  assert.equal(overLimit.status, 409);
  assert.equal((await overLimit.json() as { error: { code: string } }).error.code, "project_limit_reached");
});

test("workspace branding is admin-scoped and public custom-domain lookup is safe", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => ({ user: { id: headers.get("x-test-user") ?? "workspace-admin", emailVerified: true } }));
  setOrganizationAccessResolverForTests(async (_headers, organizationId, userId) => userId === "workspace-admin" ? { id: organizationId, role: "owner" } : undefined);
  const api = app();
  const adminHeaders = { "x-test-user": "workspace-admin", "Content-Type": "application/json" };
  const save = await api.fetch(new Request("http://local/v1/account/organizations/org_acme/branding", { method: "PUT", headers: adminHeaders, body: JSON.stringify({ displayName: "Acme Revenue", logoUrl: "https://assets.example.test/acme.svg", accentColor: "#123456", backgroundColor: "#f0f1ee", customDomain: "app.acme.example" }) }));
  assert.equal(save.status, 200);
  assert.equal((await save.json() as { data: { customDomainStatus: string } }).data.customDomainStatus, "pending_dns");
  const publicBranding = await api.fetch(new Request("http://local/public/company-branding?hostname=app.acme.example"));
  assert.equal(publicBranding.status, 200);
  const publicBody = await publicBranding.json() as { data: { displayName: string; logoUrl?: string } };
  assert.equal(publicBody.data.displayName, "Acme Revenue");
  assert.equal(publicBody.data.logoUrl, "https://assets.example.test/acme.svg");
  const unauthorized = await api.fetch(new Request("http://local/v1/account/organizations/org_acme/branding", { headers: { "x-test-user": "different-user" } }));
  assert.equal(unauthorized.status, 403);
});

test("company projects are shared to workspace members but only admins control credentials and policy", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => {
    const id = headers.get("x-test-web-user");
    return id ? { user: { id, emailVerified: true } } : null;
  });
  setOrganizationAccessResolverForTests(async (_headers, organizationId, userId) => {
    if (organizationId !== "org_acme") return undefined;
    return { id: organizationId, role: userId === "owner" ? "owner" : userId === "admin" ? "admin" : "member" };
  });
  const api = app();
  const web = (user: string, path: string, init: RequestInit = {}) => new Request(`http://local/v1${path}`, {
    ...init,
    headers: { "X-Test-Web-User": user, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const created = await api.fetch(web("owner", "/account/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Acme sales", organizationId: "org_acme" }),
  }));
  assert.equal(created.status, 201);
  const project = await created.json() as { id: string; key: string; organizationId: string; scopes: string[] };
  assert.equal(project.organizationId, "org_acme");
  assert.ok(project.scopes.includes("agents:read"));
  assert.ok(project.scopes.includes("apps:write"));
  assert.ok(project.scopes.includes("triggers:write"));
  assert.ok(project.scopes.includes("calls:write"));
  assert.ok(project.scopes.includes("voice:read"));
  assert.ok(project.scopes.includes("meetings:write"));
  assert.ok(project.scopes.includes("approvals:read"));
  assert.ok(!project.scopes.includes("approvals:write"));
  assert.ok(!project.scopes.includes("*"));
  const record = (await getSession(0)).sdkProjects!.find((item) => item.id === project.id)!;
  assert.ok(record.companyPolicy?.budget?.maxToolCalls);
  assert.ok(record.companyPolicy?.tools?.requireApproval?.includes("COMPOSIO_EXECUTE_TOOL"));

  const memberProjects = await api.fetch(web("member", "/account/projects?organizationId=org_acme"));
  assert.equal(memberProjects.status, 200);
  const listedProjects = await memberProjects.json() as { data: Array<{ id: string; key?: string }> };
  assert.equal(listedProjects.data[0]?.id, project.id);
  assert.equal(JSON.stringify(listedProjects).includes(project.key), false);
  const outsider = await api.fetch(web("outsider", "/account/projects?organizationId=org_other"));
  assert.equal(outsider.status, 404);

  const policyBody = { tools: { allow: ["COMPOSIO_SEARCH_WEB"], requireApproval: [] }, budget: { duration: "30m", maxToolCalls: 12, maxCost: 1 } };
  const memberPolicyWrite = await api.fetch(web("member", `/account/projects/${project.id}/policy`, { method: "PUT", body: JSON.stringify(policyBody) }));
  assert.equal(memberPolicyWrite.status, 404);
  const adminPolicyWrite = await api.fetch(web("admin", `/account/projects/${project.id}/policy`, { method: "PUT", body: JSON.stringify(policyBody) }));
  assert.equal(adminPolicyWrite.status, 200);
  const savedPolicy = await api.fetch(web("member", `/account/projects/${project.id}/policy`));
  assert.equal(savedPolicy.status, 200);
  assert.deepEqual((await savedPolicy.json() as { data: typeof policyBody }).data.tools.allow, ["COMPOSIO_SEARCH_WEB"]);

  const addAgent = await api.fetch(web("admin", `/account/projects/${project.id}/agents`, { method: "POST", body: JSON.stringify({ template: "lead-research", name: "Fintech lead scout" }) }));
  assert.equal(addAgent.status, 201);
  const agent = await addAgent.json() as { id: string; name: string };
  assert.equal(agent.name, "Fintech lead scout");
  const memberAgents = await api.fetch(web("member", `/account/projects/${project.id}/agents`));
  assert.equal((await memberAgents.json() as { data: Array<{ id: string }> }).data[0]?.id, agent.id);
  const memberRotate = await api.fetch(web("member", `/account/projects/${project.id}/rotate-key`, { method: "POST" }));
  assert.equal(memberRotate.status, 404);

  const companyHeaders = { Authorization: `Bearer ${project.key}`, "X-Chusky-User-Id": "acme-service-user", "Content-Type": "application/json" };
  const createAgentOnce = () => new Request("http://local/v1/agents", {
    method: "POST", headers: { ...companyHeaders, "Idempotency-Key": "company-agent-once" },
    body: JSON.stringify({ template: "competitive-intelligence", name: "Competitor monitor" }),
  });
  const firstAgentResponse = await api.fetch(createAgentOnce());
  assert.equal(firstAgentResponse.status, 201);
  const firstAgent = await firstAgentResponse.json() as { id: string };
  const replayAgentResponse = await api.fetch(createAgentOnce());
  assert.equal(replayAgentResponse.status, 201);
  assert.equal((await replayAgentResponse.json() as { id: string }).id, firstAgent.id);
  const mismatchedAgent = await api.fetch(new Request("http://local/v1/agents", {
    method: "POST", headers: { ...companyHeaders, "Idempotency-Key": "company-agent-once" },
    body: JSON.stringify({ template: "lead-research", name: "Changed" }),
  }));
  assert.equal(mismatchedAgent.status, 409);

  const threadResponse = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: companyHeaders, body: "{}" }));
  assert.equal(threadResponse.status, 201);
  const thread = await threadResponse.json() as { id: string };
  const widenedRun = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs`, {
    method: "POST", headers: companyHeaders,
    body: JSON.stringify({ input: "Send an email", agentId: agent.id, wait: false, tools: { allow: ["COMPOSIO_EXECUTE_TOOL"] } }),
  }));
  assert.equal(widenedRun.status, 403);
  assert.equal((await widenedRun.json() as { error: { code: string } }).error.code, "agent_policy_denied");
  const malformedPolicy = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs`, {
    method: "POST", headers: companyHeaders,
    body: JSON.stringify({ input: "Bad policy", wait: false, tools: { allow: "COMPOSIO_SEARCH_WEB" } }),
  }));
  assert.equal(malformedPolicy.status, 400);
});

test("company telemetry is visible across project callers but isolated by workspace project", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setSdkTaskWorkflowEnqueuerForTests(async () => "workflow-test");
  setWebAuthSessionResolverForTests(async (headers) => {
    const id = headers.get("x-test-web-user");
    return id ? { user: { id, emailVerified: true } } : null;
  });
  setOrganizationAccessResolverForTests(async (_headers, organizationId, userId) => {
    if (organizationId !== "org_telemetry") return undefined;
    return { id: organizationId, role: userId === "owner" || userId === "admin" ? "admin" : "member" };
  });
  const api = app();
  const web = (user: string, path: string, init: RequestInit = {}) => new Request(`http://local/v1${path}`, {
    ...init,
    headers: { "X-Test-Web-User": user, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const createProject = async (name: string) => {
    const response = await api.fetch(web("owner", "/account/projects", {
      method: "POST", body: JSON.stringify({ name, organizationId: "org_telemetry" }),
    }));
    assert.equal(response.status, 201);
    return await response.json() as { id: string; key: string };
  };
  const first = await createProject("Sales workspace");
  const second = await createProject("Support workspace");
  const keyHeaders = (key: string, caller: string) => ({ Authorization: `Bearer ${key}`, "X-Chusky-User-Id": caller, "Content-Type": "application/json" });
  const headersA = keyHeaders(first.key, "sales-service-a");
  const createdThread = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: headersA, body: "{}" }));
  assert.equal(createdThread.status, 201);
  const thread = await createdThread.json() as { id: string };
  const queued = await api.fetch(new Request(`http://local/v1/threads/${thread.id}/runs`, {
    method: "POST", headers: headersA, body: JSON.stringify({ input: "Private prospect research prompt", wait: false }),
  }));
  assert.equal(queued.status, 202);
  const run = await queued.json() as { id: string; status: string };
  assert.equal(run.status, "queued");

  const headersB = keyHeaders(first.key, "sales-service-b");
  const sharedRuns = await api.fetch(new Request("http://local/v1/company/runs", { headers: headersB }));
  assert.equal(sharedRuns.status, 200);
  const runData = await sharedRuns.json() as { data: Array<{ id: string; status: string }>; nextCursor?: string };
  assert.equal(runData.data.length, 1);
  assert.equal(runData.data[0]?.id, run.id);
  assert.equal(runData.data[0]?.status, "queued");
  assert.equal(JSON.stringify(runData).includes("Private prospect research prompt"), false);

  const completedRun = {
    id: run.id, status: "completed", companyProjectId: first.id, cost: 0.42,
    createdAt: Date.now() - 1_000, updatedAt: Date.now(), events: [],
  } as Parameters<typeof persistSdkCompanyRun>[0];
  await persistSdkCompanyRun(completedRun);
  await persistSdkCompanyRun(completedRun); // A repeated durable completion must not double-charge company usage.
  const refreshedRuns = await api.fetch(new Request("http://local/v1/company/runs", { headers: headersB }));
  assert.equal((await refreshedRuns.json() as { data: Array<{ status: string }> }).data[0]?.status, "completed");
  const usage = await api.fetch(new Request("http://local/v1/company/usage", { headers: headersB }));
  assert.equal(usage.status, 200);
  const usageData = await usage.json() as { currentMonth: { completedRuns: number; costUsd: number } };
  assert.equal(usageData.currentMonth.completedRuns, 1);
  assert.equal(usageData.currentMonth.costUsd, 0.42);

  const companyAudit = await api.fetch(new Request("http://local/v1/company/audit-events?limit=20", { headers: headersB }));
  assert.equal(companyAudit.status, 200);
  const auditData = await companyAudit.json() as { data: Array<{ action: string; status: number }> };
  assert.ok(auditData.data.some((item) => item.action === "POST /v1/threads" && item.status === 201));

  const isolated = await api.fetch(new Request("http://local/v1/company/runs", { headers: keyHeaders(second.key, "support-service") }));
  assert.equal(isolated.status, 200);
  assert.equal((await isolated.json() as { data: unknown[] }).data.length, 0);

  const dashboardReads = await Promise.all([
    api.fetch(web("admin", `/account/projects/${first.id}/company/runs`)),
    api.fetch(web("admin", `/account/projects/${first.id}/company/audit-events`)),
    api.fetch(web("admin", `/account/projects/${first.id}/company/usage`)),
  ]);
  assert.deepEqual(dashboardReads.map((response) => response.status), [200, 200, 200]);
  const memberRead = await api.fetch(web("member", `/account/projects/${first.id}/company/runs`));
  assert.equal(memberRead.status, 404);
});

test("linked verified dashboard users can request and list phone calls without exposing destinations", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  Object.assign(config as unknown as Record<string, unknown>, { twilioVoiceEnabled: true, twilioAccountSid: "AC123", twilioAuthToken: "token", twilioCallerId: "+16452437121", twilioWebhookBaseUrl: "https://chusky.example", twilioMediaStreamUrl: "wss://voice.example/twilio/stream" });
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("alice");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 810099), "linked");
  const api = app();
  const headers = { "X-Test-Web-User": "alice", "Content-Type": "application/json" };
  const create = await api.fetch(new Request("http://local/v1/account/calls", { method: "POST", headers, body: JSON.stringify({ phoneNumber: "+15550001", purpose: "Confirm appointment", profile: { identity: "Harvey's assistant", organization: "Harvey Motors", mode: "sales", tone: "warm", facts: ["Test drives are available by appointment."], capabilities: ["schedule_lookup"] } }) }));
  assert.equal(create.status, 201);
  const call = await create.json() as { id: string; phoneNumber: string; status: string };
  assert.equal(call.phoneNumber, "+••••0001");
  assert.equal(call.status, "bridging");
  const listed = await api.fetch(new Request("http://local/v1/account/calls", { headers }));
  assert.equal(listed.status, 200);
  const body = await listed.json() as { available: boolean; provider: string | null; data: unknown[] };
  assert.equal(body.available, true);
  assert.equal(body.provider, "twilio");
  assert.deepEqual(body.data, []);
});

test("Bland readiness controls dashboard call availability and the selected provider", async () => {
  const keys = ["betterAuthEnabled", "blandVoiceEnabled", "blandApiKey", "blandWebhookSecret", "blandWebhookUrl", "blandConsultToolId", "blandConsultToolSecret", "twilioVoiceEnabled"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, config[key]]));
  try {
    Object.assign(config, {
      betterAuthEnabled: true, blandVoiceEnabled: true, blandApiKey: "bland-key",
      blandWebhookSecret: "a-distinct-webhook-signing-secret-with-entropy",
      blandWebhookUrl: "https://chusky.example/bland/webhook",
      blandConsultToolId: "TL-1234567890", blandConsultToolSecret: "a-distinct-url-safe-tool-secret-with-entropy",
      twilioVoiceEnabled: false,
    });
    setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
    const link = await createWebTelegramLinkCode("bland-user");
    assert.equal(await redeemWebTelegramLinkCode(link.code, 810100), "linked");
    const api = app();
    const headers = { "X-Test-Web-User": "bland-user", "Content-Type": "application/json" };
    const listed = await api.fetch(new Request("http://local/v1/account/calls", { headers }));
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { available: true, provider: "bland", data: [] });
    const requested = await api.fetch(new Request("http://local/v1/account/calls", { method: "POST", headers, body: JSON.stringify({ phoneNumber: "+15550001", purpose: "Follow up on the demo" }) }));
    assert.equal(requested.status, 201);
  } finally {
    Object.assign(config, original);
    setWebAuthSessionResolverForTests();
  }
});

test("SDK callers can use scoped voice and call resources with idempotent requests", async () => {
  const keys = ["twilioVoiceEnabled", "twilioAccountSid", "twilioAuthToken", "twilioCallerId", "twilioWebhookBaseUrl", "twilioMediaStreamUrl"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, config[key]]));
  try {
    Object.assign(config, { twilioVoiceEnabled: true, twilioAccountSid: "AC123", twilioAuthToken: "token", twilioCallerId: "+16452437121", twilioWebhookBaseUrl: "https://chusky.example", twilioMediaStreamUrl: "wss://voice.example/twilio/stream" });
    const api = app();
    const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "sdk-caller", "Content-Type": "application/json" };
    const voices = await api.fetch(new Request("http://local/v1/account/voice-options", { headers }));
    assert.equal(voices.status, 200);
    assert.ok((await voices.json() as { fluxVoices: Array<{ id: string }> }).fluxVoices.some((voice) => voice.id === "flux-haley-en"));
    const callHeaders = { ...headers, "Idempotency-Key": "sdk-call-once" };
    const first = await api.fetch(new Request("http://local/v1/account/calls", { method: "POST", headers: callHeaders, body: JSON.stringify({ phoneNumber: "+15550001", purpose: "Confirm appointment" }) }));
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { id: string };
    const replay = await api.fetch(new Request("http://local/v1/account/calls", { method: "POST", headers: callHeaders, body: JSON.stringify({ phoneNumber: "+15550001", purpose: "Confirm appointment" }) }));
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as { id: string }).id, firstBody.id);
    const mismatch = await api.fetch(new Request("http://local/v1/account/calls", { method: "POST", headers: callHeaders, body: JSON.stringify({ phoneNumber: "+15550002", purpose: "Confirm appointment" }) }));
    assert.equal(mismatch.status, 409);
  } finally {
    Object.assign(config, original);
  }
});

test("linked dashboard can read owner-scoped meeting preparation, outcomes, roster, and contacts without meeting URLs", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("meeting-owner");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 820001), "linked");
  const now = Date.now();
  await createTriggerEvent({ eventId: "cal-trigger-820001", userId: 820001, triggerSlug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", summary: "Calendar meeting created", status: "completed", result: "Recommendation: review the last pricing discussion and ask about their launch date.", createdAt: now, updatedAt: now });
  await saveCalendarMeetingPreparation(820001, { id: "cmp_owner_meeting_1", userId: 820001, sourceTriggerEventId: "cal-trigger-820001", calendarEventId: "event-820001", lifecycle: "created", status: "prepared", title: "Acme discovery", startAt: new Date(now + 60_000).toISOString(), participants: ["Avery", "client@example.com"], createdAt: now, updatedAt: now });
  await addRecallMeeting(820001, { id: "mtg_owner_meeting_1", userId: 820001, platform: "google_meet", status: "in_call", interactionMode: "representative", meetingUrlHash: "a".repeat(64), title: "Acme discovery", participantRoster: [{ id: "p1", name: "Avery", isHost: true, status: "present", updatedAt: now }], history: [{ role: "user", content: "Can we schedule a test drive?", createdAt: now }, { role: "assistant", content: "I can check a time that works.", createdAt: now }], createdAt: now, updatedAt: now });
  await upsertMeetingContact(820001, "mtg_owner_meeting_1", { participantName: "Avery", email: "avery@example.com", contactPreference: "email", interest: "Test drive", nextStep: "Confirm a time" });

  const api = app();
  const headers = { "X-Test-Web-User": "meeting-owner", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/meetings", { headers }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { preparations: Array<Record<string, unknown>>; meetings: Array<Record<string, unknown>>; contacts: Array<Record<string, unknown>> };
  assert.equal(payload.preparations[0]?.brief, "Recommendation: review the last pricing discussion and ask about their launch date.");
  assert.deepEqual(payload.preparations[0]?.participants, ["Avery", "client@example.com"]);
  assert.deepEqual(payload.meetings[0]?.participantRoster, [{ id: "p1", name: "Avery", isHost: true, status: "present", updatedAt: new Date(now).toISOString() }]);
  assert.equal((payload.meetings[0]?.history as Array<{ content: string }>)[0]?.content, "Can we schedule a test drive?");
  assert.equal(payload.contacts[0]?.email, "avery@example.com");
  assert.equal(JSON.stringify(payload).includes("sealedMeetingUrl"), false);
  assert.equal(JSON.stringify(payload).includes("meetingUrlHash"), false);

  const otherLink = await createWebTelegramLinkCode("other-meeting-owner");
  assert.equal(await redeemWebTelegramLinkCode(otherLink.code, 820002), "linked");
  const other = await api.fetch(new Request("http://local/v1/meetings", { headers: { ...headers, "X-Test-Web-User": "other-meeting-owner" } }));
  assert.deepEqual(await other.json(), { preparations: [], meetings: [], contacts: [] });
});

test("linked dashboard can manage the meeting representative profile and per-provider live voices", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("meeting-settings-owner");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 820003), "linked");
  const api = app();
  const headers = { "X-Test-Web-User": "meeting-settings-owner", "Content-Type": "application/json" };
  const profile = await api.fetch(new Request("http://local/v1/meetings/profile", { headers }));
  assert.equal(profile.status, 200);
  assert.equal((await profile.json() as { representativeName: string }).representativeName, "Chusky");
  const update = await api.fetch(new Request("http://local/v1/meetings/profile", { method: "PATCH", headers, body: JSON.stringify({ enabled: true, role: "sales", objective: "Qualify this opportunity and agree a practical next step", representativeName: "Chusky", allowedComposioTools: ["GOOGLECALENDAR_FIND_EVENT"] }) }));
  assert.equal(update.status, 200);
  assert.equal((await update.json() as { allowedComposioTools: string[] }).allowedComposioTools[0], "GOOGLECALENDAR_FIND_EVENT");
  const autoJoinEnabled = await api.fetch(new Request("http://local/v1/meetings/profile", { method: "PATCH", headers, body: JSON.stringify({ autoJoinCalendar: true }) }));
  assert.equal(autoJoinEnabled.status, 200);
  await addRecallMeeting(820003, { id: "mtg_auto_join_disable", userId: 820003, platform: "google_meet", interactionMode: "representative", status: "scheduled", providerBotId: "recall-auto-join-test", meetingUrlHash: "a".repeat(64), calendarPreparationId: "cmp_auto_join_disable", history: [], createdAt: Date.now(), updatedAt: Date.now() });
  const autoJoinDisabled = await api.fetch(new Request("http://local/v1/meetings/profile", { method: "PATCH", headers, body: JSON.stringify({ autoJoinCalendar: false }) }));
  assert.equal(autoJoinDisabled.status, 200);
  const autoJoinResult = await autoJoinDisabled.json() as { autoJoinCalendar: boolean; autoJoinReconciliation: { failures: number } };
  assert.equal(autoJoinResult.autoJoinCalendar, false);
  assert.equal(autoJoinResult.autoJoinReconciliation.failures, 1);
  const invalidProfile = await api.fetch(new Request("http://local/v1/meetings/profile", { method: "PATCH", headers, body: JSON.stringify({ unknownSetting: true }) }));
  assert.equal(invalidProfile.status, 400);

  const voice = await api.fetch(new Request("http://local/v1/account/preferences", { method: "PATCH", headers, body: JSON.stringify({ liveVoice: { provider: "meetings", voice: "flux-haley-en" } }) }));
  assert.equal(voice.status, 200);
  assert.deepEqual((await voice.json() as { voicePreferences: Record<string, string> }).voicePreferences, { meetings: "flux-haley-en" });
  const invalidVoice = await api.fetch(new Request("http://local/v1/account/preferences", { method: "PATCH", headers, body: JSON.stringify({ liveVoice: { provider: "meetings", voice: "unknown-voice" } }) }));
  assert.equal(invalidVoice.status, 400);
});

test("dashboard channel controls create one-time link codes, update notification preference, and unlink only owned identities", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("channel-owner");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 820004), "linked");
  const api = app();
  const headers = { "X-Test-Web-User": "channel-owner", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/channels/link-code", { method: "POST", headers, body: JSON.stringify({ provider: "whatsapp" }) }));
  assert.equal(created.status, 201);
  const code = await created.json() as { code: string };
  await redeemLinkCode("whatsapp", code.code, "whatsapp-user-820004", "business-account");
  const list = await api.fetch(new Request("http://local/v1/channels", { headers }));
  const channel = (await list.json() as { data: Array<{ id: string; provider: string; proactiveOptIn: boolean }> }).data[0]!;
  assert.equal(channel.provider, "whatsapp");
  assert.equal(channel.proactiveOptIn, false);
  const updated = await api.fetch(new Request(`http://local/v1/channels/${channel.provider}/${channel.id}`, { method: "PATCH", headers, body: JSON.stringify({ proactiveOptIn: true }) }));
  assert.equal((await updated.json() as { proactiveOptIn: boolean }).proactiveOptIn, true);
  const removed = await api.fetch(new Request(`http://local/v1/channels/${channel.provider}/${channel.id}`, { method: "DELETE", headers }));
  assert.equal(removed.status, 204);
  assert.deepEqual((await api.fetch(new Request("http://local/v1/channels", { headers })).then((response) => response.json()) as { data: unknown[] }).data, []);
  const primary = await api.fetch(new Request("http://local/v1/channels/telegram/0000000000000000", { method: "DELETE", headers }));
  assert.equal(primary.status, 409);
});

test("linked dashboard memory and account overview share one active, owner-scoped projection", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("memory-owner");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 820006), "linked");
  await upsertMemory(820006, { category: "fact", key: "preferred_crm", value: "HubSpot", confidence: 1, sensitivity: "normal", source: "telegram" });
  await upsertMemory(820006, { category: "fact", key: "expired_fact", value: "must not be shown", confidence: 1, sensitivity: "normal", source: "telegram", expiresAt: Date.now() - 1 });

  const api = app();
  const headers = { "X-Test-Web-User": "memory-owner" };
  const listed = await api.fetch(new Request("http://local/v1/memory", { headers }));
  const overview = await api.fetch(new Request("http://local/v1/account/overview", { headers }));
  assert.equal(listed.status, 200);
  assert.equal(overview.status, 200);
  const listData = (await listed.json() as { data: Array<{ id: string; key: string; source?: string }> }).data;
  const overviewBody = await overview.json() as { memory: Array<{ id: string; key: string; source?: string }>; telegramLink: { linked: boolean } };
  const overviewData = overviewBody.memory;
  assert.equal(overviewBody.telegramLink.linked, true);
  assert.deepEqual(overviewData.map(({ id, key, source }) => ({ id, key, source })), listData.map(({ id, key, source }) => ({ id, key, source })));
  assert.equal(listData.some((item) => item.key === "expired_fact"), false);
  assert.equal(overviewData.some((item) => item.key === "expired_fact"), false);
});

test("dashboard devices are revocable by opaque owner-scoped IDs, without exposing token hashes", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  const link = await createWebTelegramLinkCode("device-owner");
  assert.equal(await redeemWebTelegramLinkCode(link.code, 820005), "linked");
  const paired = await createCliDevice(820005, "Harvey's laptop");
  const api = app();
  const headers = { "X-Test-Web-User": "device-owner", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/devices", { headers }));
  const device = (await response.json() as { data: Array<{ id: string; name: string }> }).data[0]!;
  assert.equal(device.name, "Harvey's laptop");
  assert.equal(JSON.stringify(device).includes(paired.device.tokenHash), false);
  const revoked = await api.fetch(new Request(`http://local/v1/devices/${device.id}`, { method: "DELETE", headers }));
  assert.equal(revoked.status, 204);
  assert.equal(await authenticateCliToken(paired.token), undefined);
});

test("connected-app disconnect is scoped to an account-owned Composio connection", async () => {
  let ownerId = "";
  const deleted: string[] = [];
  setAgentDependenciesForTests({ composio: { connectedAccounts: {
    list: async ({ userIds }: { userIds: string[] }) => {
      if (!ownerId) ownerId = userIds[0]!;
      return userIds[0] === ownerId ? { items: [{ id: "conn_owned_123", alias: "Work Gmail", toolkit: { slug: "gmail" }, status: "ACTIVE" }] } : { items: [] };
    },
    delete: async (id: string) => { deleted.push(id); return { success: true }; },
  } } });
  const api = app();
  const headers = (user: string) => ({ Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": user });
  const listed = await api.fetch(new Request("http://local/v1/apps/connections", { headers: headers("owner") }));
  const account = (await listed.json() as { data: Array<{ id: string; alias: string; toolkit: string }> }).data[0]!;
  assert.deepEqual(account, { id: "conn_owned_123", alias: "Work Gmail", toolkit: "gmail", status: "ACTIVE" });
  const wrongOwner = await api.fetch(new Request(`http://local/v1/apps/connections/${account.id}`, { method: "DELETE", headers: headers("other-owner") }));
  assert.equal(wrongOwner.status, 404);
  assert.deepEqual(deleted, []);
  const removed = await api.fetch(new Request(`http://local/v1/apps/connections/${account.id}`, { method: "DELETE", headers: headers("owner") }));
  assert.equal(removed.status, 204);
  assert.deepEqual(deleted, [account.id]);
});

test("connected-app catalogue returns official Composio metadata with cursor pagination", async () => {
  let received: Record<string, unknown> | undefined;
  setAgentDependenciesForTests({ composio: {
    connectedAccounts: { list: async () => ({ items: [{ id: "conn_gmail", alias: "Work Gmail", toolkit: { slug: "gmail" }, status: "ACTIVE" }] }) },
    toolkits: { get: async () => ({ name: "Gmail", slug: "gmail", meta: { logo: "https://cdn.example/gmail.svg", description: "Email and search", appUrl: "https://gmail.google.com", categories: [{ name: "Communication" }], toolsCount: 42, triggersCount: 3 }, composioManagedAuthSchemes: ["oauth2"] }) },
    create: async () => ({ toolkits: async (options: Record<string, unknown>) => { received = options; return { items: [{ slug: "gmail", name: "Gmail", logo: "https://cdn.example/gmail.svg", isNoAuth: false, connection: { isActive: true } }], cursor: "next-page", currentPage: 1, totalPages: 2, totalItems: 31 }; } }),
  } });
  const api = app();
  const response = await api.fetch(new Request("http://local/v1/apps?limit=30&search=gmail", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "apps-owner" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { limit: 30, search: "gmail" });
  const payload = await response.json() as { data: Array<Record<string, unknown>>; nextCursor: string; currentPage: number; totalPages: number; total: number };
  assert.equal(payload.nextCursor, "next-page");
  assert.equal(payload.currentPage, 1);
  assert.equal(payload.totalPages, 2);
  assert.equal(payload.total, 31);
  assert.deepEqual(payload.data[0], {
    slug: "gmail", name: "Gmail", connected: true, logo: "https://cdn.example/gmail.svg", description: "Email and search", appUrl: "https://gmail.google.com", categories: ["Communication"], toolsCount: 42, triggersCount: 3, authSchemes: ["oauth2"], noAuth: false, accountCount: 1, aliases: ["Work Gmail"],
  });
});

test("meeting capabilities expose safe exact actions with connected-account state", async () => {
  setAgentDependenciesForTests({ composio: {
    connectedAccounts: {
      list: async () => ({ items: [{ id: "conn_gmail_1", alias: "Work Gmail", toolkit: { slug: "gmail" }, status: "ACTIVE" }] }),
    },
    create: async () => ({ sessionId: "meeting-capabilities-session", tools: async () => [
      { function: { name: "GMAIL_SEND_EMAIL", description: "Send an email" } },
      { function: { name: "GOOGLECALENDAR_FIND_EVENT", description: "Find a calendar event" } },
      { function: { name: "GITHUB_DELETE_REPOSITORY", description: "Delete a repository" } },
      { function: { name: "COMPOSIO_EXECUTE_TOOL", description: "Execute a dynamic tool" } },
    ] }),
  } });
  const api = app();
  const response = await api.fetch(new Request("http://local/v1/meetings/capabilities", { headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "capability-owner" } }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { composioAvailable: boolean; connections: Array<{ id: string; alias?: string }>; composioTools: Array<{ slug: string; connected: boolean }> };
  assert.equal(payload.composioAvailable, true);
  assert.deepEqual(payload.connections, [{ id: "conn_gmail_1", alias: "Work Gmail", toolkit: "gmail", status: "ACTIVE" }]);
  assert.deepEqual(payload.composioTools.map((tool) => tool.slug), ["GMAIL_SEND_EMAIL", "GOOGLECALENDAR_FIND_EVENT"]);
  assert.equal(payload.composioTools.find((tool) => tool.slug === "GMAIL_SEND_EMAIL")?.connected, true);
  assert.equal(payload.composioTools.find((tool) => tool.slug === "GOOGLECALENDAR_FIND_EVENT")?.connected, false);
});

test("workspace meeting rooms are organization-scoped and do not expose private meeting state", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => headers.get("x-test-web-user") ? { user: { id: headers.get("x-test-web-user")!, emailVerified: true } } : null);
  setOrganizationAccessResolverForTests(async (_headers, organizationId, userId) => userId === "workspace-admin" ? { id: organizationId, role: "owner" } : undefined);
  const api = app();
  const headers = { "X-Test-Web-User": "workspace-admin", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/meetings/rooms", { method: "POST", headers, body: JSON.stringify({ organizationId: "better-auth-org", name: "Marketing", policy: { defaultMode: "addressed", visibility: "organization", allowedComposioTools: [], allowedNativeTools: [], requireApprovalForExternalActions: true, allowScreenUnderstanding: false } }) }));
  assert.equal(created.status, 201);
  const room = await created.json() as { id: string; organizationId: string; policy: { visibility: string } };
  assert.equal(room.organizationId, "better-auth-org");
  assert.equal(room.policy.visibility, "organization");
  const listed = await api.fetch(new Request("http://local/v1/meetings?organizationId=better-auth-org", { headers }));
  assert.equal(listed.status, 200);
  const body = await listed.json() as { rooms: Array<{ id: string }>; meetings: unknown[] };
  assert.deepEqual(body.rooms.map((item) => item.id), [room.id]);
  assert.deepEqual(body.meetings, []);
});
