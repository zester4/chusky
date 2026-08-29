import assert from "node:assert/strict";
import test from "node:test";
import { Chusky, ChuskyAuthenticationError, ChuskyRateLimitError, createChuskyAdmin } from "../src/index.js";

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => responder(String(input), init)) as typeof fetch;
}

test("admin factory supplies a server-only operator identity", async () => {
  let userHeader = "";
  const admin = createChuskyAdmin({ apiKey: "root_secret", baseUrl: "https://example.test", fetch: mockFetch((_url, init) => {
    userHeader = new Headers(init?.headers).get("x-chusky-user-id") ?? "";
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) });
  await admin.projects.list();
  assert.equal(userHeader, "operator");
});

test("SDK uses the v1 API, bearer key, and idempotency key", async () => {
  let captured: { url: string; headers: Headers; body: string | undefined } | undefined;
  const sdk = new Chusky({ apiKey: "chsk_test_secret", userId: "customer_1", baseUrl: "https://example.test/", fetch: mockFetch((url, init) => {
    captured = { url, headers: new Headers(init?.headers), body: String(init?.body) };
    return new Response(JSON.stringify({ id: "thr_1", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), { status: 200 });
  }) });
  const thread = await sdk.threads.create({ externalId: "user_1" }, { idempotencyKey: "idem_1" });
  assert.equal(thread.id, "thr_1");
  assert.equal(captured?.url, "https://example.test/v1/threads");
  assert.equal(captured?.headers.get("authorization"), "Bearer chsk_test_secret");
  assert.equal(captured?.headers.get("x-chusky-user-id"), "customer_1");
  assert.equal(captured?.headers.get("idempotency-key"), "idem_1");
  assert.match(captured?.body ?? "", /user_1/);
});

test("SDK exposes typed authentication and rate-limit errors", async () => {
  const unauthorized = new Chusky({ apiKey: "bad", userId: "customer_1", baseUrl: "https://example.test", fetch: mockFetch(() => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Nope" } }), { status: 401, headers: { "x-request-id": "req_1" } })) });
  await assert.rejects(() => unauthorized.threads.get("thr_1"), (error: unknown) => error instanceof ChuskyAuthenticationError && error.requestId === "req_1");
  const limited = new Chusky({ apiKey: "key", userId: "customer_1", baseUrl: "https://example.test", fetch: mockFetch(() => new Response(JSON.stringify({ error: { code: "rate_limited", message: "Slow down" } }), { status: 429, headers: { "retry-after": "12" } })) });
  await assert.rejects(() => limited.tasks.list(), (error: unknown) => error instanceof ChuskyRateLimitError && error.retryAfter === 12);
});

test("SDK parses NDJSON run events in order", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"run.started","run":{"id":"run_1"}}\n{"type":"run.delta","runId":"run_1","text":"Hello"}\n')); controller.close(); } });
  const sdk = new Chusky({ apiKey: "key", userId: "customer_1", baseUrl: "https://example.test", fetch: mockFetch(() => new Response(stream, { status: 200 })) });
  const events = [] as Array<{ type: string }>;
  for await (const event of sdk.threads.runs("thr_1").stream({ input: "hi" })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["run.started", "run.delta"]);
});

test("SDK exposes root project lifecycle endpoints", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const sdk = new Chusky({ apiKey: "root", userId: "operator", baseUrl: "https://example.test", fetch: mockFetch((url, init) => { calls.push({ url, method: init?.method, body: String(init?.body ?? "") }); return new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: "proj_1", name: "Acme", keyPrefix: "chsk_proj", scopes: ["*"], createdAt: "2026-01-01T00:00:00.000Z" }), { status: init?.method === "DELETE" ? 204 : 200 }); }) });
  await sdk.projects.create({ name: "Acme", scopes: ["threads:read"] });
  await sdk.projects.updateScopes("proj_1", ["threads:write"]);
  await sdk.projects.rotateKey("proj_1");
  await sdk.projects.revoke("proj_1");
  assert.deepEqual(calls.map((call) => `${call.method}:${call.url}`), ["POST:https://example.test/v1/admin/projects", "PATCH:https://example.test/v1/admin/projects/proj_1", "POST:https://example.test/v1/admin/projects/proj_1/rotate-key", "DELETE:https://example.test/v1/admin/projects/proj_1"]);
});

test("SDK file deletion accepts the no-content response", async () => {
  let captured: { url: string; method?: string } | undefined;
  const sdk = new Chusky({ apiKey: "key", userId: "customer", baseUrl: "https://example.test", fetch: mockFetch((url, init) => { captured = { url, method: init?.method }; return new Response(null, { status: 204 }); }) });
  await sdk.files.delete("file_1");
  assert.deepEqual(captured, { url: "https://example.test/v1/files/file_1", method: "DELETE" });
});
