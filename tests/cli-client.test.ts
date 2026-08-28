import test from "node:test";
import assert from "node:assert/strict";
import { ChuskyClient } from "../src/cli/client.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("CLI client sends bearer auth and normalizes trailing server slash", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    request = new Request(input, init);
    return response({ ok: true, userId: 12 });
  }) as typeof fetch;
  try {
    const result = await new ChuskyClient({ serverUrl: "https://example.test/", token: "secret" }).session();
    assert.equal(result.ok, true);
    assert.equal(request?.url, "https://example.test/cli/session");
    assert.equal(request?.headers.get("authorization"), "Bearer secret");
  } finally { globalThis.fetch = original; }
});

test("CLI client reports HTTP failures and validates missing server configuration", async () => {
  await assert.rejects(() => new ChuskyClient({ serverUrl: "" }).session(), /CHUSKY_SERVER_URL/);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response({ ok: false }, 401)) as typeof fetch;
  try {
    const result = await new ChuskyClient({ serverUrl: "https://example.test" }).session();
    assert.equal(result.ok, false);
    assert.equal(result.error, "HTTP 401");
  } finally { globalThis.fetch = original; }
});

test("CLI client serializes chat approvals and clear/model requests", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    calls.push({ path: new URL(request.url).pathname, body: JSON.parse(await request.text()) });
    return response({ ok: true });
  }) as typeof fetch;
  try {
    const client = new ChuskyClient({ serverUrl: "https://example.test", token: "token" });
    await client.chat("run", "approval-1");
    await client.approve("approval-1", "approve");
    await client.model("test/model");
    await client.clear("history");
    assert.deepEqual(calls.map((call) => call.path), ["/cli/chat", "/cli/approve", "/cli/model", "/cli/clear"]);
    assert.deepEqual(calls[0].body, { message: "run", approvalId: "approval-1" });
    assert.deepEqual(calls[3].body, { scope: "history" });
  } finally { globalThis.fetch = original; }
});

test("CLI client parses newline-delimited streaming events", async () => {
  const original = globalThis.fetch;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"start","model":"test/model"}\n{"type":"delta","text":"hello"}\n'));
      controller.enqueue(new TextEncoder().encode('{"type":"done","text":"hello"}\n'));
      controller.close();
    },
  });
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  try {
    const events = [];
    for await (const event of new ChuskyClient({ serverUrl: "https://example.test", token: "token" }).stream("hello")) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ["start", "delta", "done"]);
    assert.equal(events[1].text, "hello");
  } finally { globalThis.fetch = original; }
});

test("CLI client URL-encodes model queries and exposes paginated results", async () => {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input) => { url = String(input); return response({ ok: true, page: 1, pageSize: 10, totalPages: 1, total: 1, models: [{ id: "test/model", name: "Test" }] }); }) as typeof fetch;
  try {
    const result = await new ChuskyClient({ serverUrl: "https://example.test" }).models(2, 25, "vision model");
    assert.equal(result.models[0].id, "test/model");
    assert.match(url, /page=2&pageSize=25&query=vision%20model/);
  } finally { globalThis.fetch = original; }
});
