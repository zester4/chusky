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

test("CLI client serializes chat approvals, direct calls, and clear/model requests", async () => {
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
    await client.call("+15550001", "Confirm appointment");
    await client.model("test/model");
    await client.clear("history");
    assert.deepEqual(calls.map((call) => call.path), ["/cli/chat", "/cli/approve", "/cli/call", "/cli/model", "/cli/clear"]);
    assert.deepEqual(calls[0].body, { message: "run", approvalId: "approval-1" });
    assert.deepEqual(calls[2].body, { phoneNumber: "+15550001", purpose: "Confirm appointment" });
    assert.deepEqual(calls[4].body, { scope: "history" });
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

test("CLI client supports device management and multipart media without JSON content headers", async () => {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return response(request.url.endsWith("/cli/devices") ? { ok: true, devices: [] } : { ok: true, text: "Analyzed" });
  }) as typeof fetch;
  try {
    const client = new ChuskyClient({ serverUrl: "https://example.test", token: "token" });
    await client.devices();
    await client.revokeDevice("office laptop");
    await client.media(new Blob(["hello"], { type: "text/plain" }), "note.txt", "summarize");
    assert.equal(requests[0].url, "https://example.test/cli/devices");
    assert.equal(requests[1].url, "https://example.test/cli/devices/office%20laptop");
    assert.equal(requests[2].headers.get("authorization"), "Bearer token");
    assert.match(requests[2].headers.get("content-type") || "", /multipart\/form-data/);
    assert.equal((await requests[2].formData()).get("message"), "summarize");
  } finally { globalThis.fetch = original; }
});

test("CLI client polls authenticated event snapshots with a monotonic cursor", async () => {
  const original = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input) => { url = String(input); return response({ ok: true, now: 1234, tasks: [], approvals: [], reminders: [], jobs: [] }); }) as typeof fetch;
  try {
    const result = await new ChuskyClient({ serverUrl: "https://example.test", token: "token" }).events(999.8);
    assert.equal(result.now, 1234);
    assert.match(url, /\/cli\/events\?since=999/);
  } finally { globalThis.fetch = original; }
});

test("CLI client exposes Telegram parity management APIs", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; method: string; body?: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    calls.push({ path: new URL(request.url).pathname, method: request.method, body: request.method === "GET" ? undefined : JSON.parse(await request.text()) });
    if (request.url.includes("/cli/apps")) return response({ ok: true, apps: [], page: 1, totalPages: 1, total: 0 });
    if (request.url.includes("/cli/tools")) return response({ ok: true, tools: [] });
    if (request.url.includes("/cli/triggers")) return response({ ok: true, triggers: [] });
    if (request.url.includes("/cli/channels")) return response({ ok: true, channels: [] });
    if (request.url.includes("/cli/usage")) return response({ ok: true, totalCost: 0 });
    if (request.url.includes("/cli/dashboard")) return response({ ok: true, url: "https://example.test/app" });
    return response({ ok: true, enabled: true, url: "https://connect.example.test", code: "123456" });
  }) as typeof fetch;
  try {
    const client = new ChuskyClient({ serverUrl: "https://example.test", token: "token" });
    await client.apps(); await client.connect("github"); await client.tools("issues"); await client.triggers();
    await client.trigger("enable", "tr-1"); await client.channels(); await client.channelLink("slack");
    await client.channelNotify("slack", true); await client.voice(true); await client.usage(); await client.dashboard();
    assert.deepEqual(calls.map((call) => call.path), ["/cli/apps", "/cli/connect", "/cli/tools", "/cli/triggers", "/cli/triggers", "/cli/channels", "/cli/channels/link", "/cli/channels/notify", "/cli/voice", "/cli/usage", "/cli/dashboard"]);
    assert.deepEqual(calls[1].body, { toolkit: "github" });
    assert.deepEqual(calls[7].body, { provider: "slack", enabled: true });
  } finally { globalThis.fetch = original; }
});
