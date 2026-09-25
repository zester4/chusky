import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as z from "zod/v4";
import { config } from "../src/config.js";
import { addCustomMcpServer, discoverToolsForUser, disconnectMcpServer, isMcpServerAllowedForUser, listMcpCatalog, listMcpCatalogForUser, listMcpConnections, namespaceMcpTool, normalizeMcpResult, parseMcpRegistry, toOpenAITool, validateMcpArguments, validateMcpUrl } from "../src/mcp/client.js";
import { getSession, initStore, saveSession } from "../src/store.js";
const originalNodeEnv = process.env.NODE_ENV;

async function startMcpFixture(options: { requireToken?: string; toolName?: string; failTools?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks).toString("utf8");
    if (!payload) { response.writeHead(202).end(); return; }
    const message = JSON.parse(payload) as { id?: string | number; method?: string; params?: { arguments?: { text?: string } } };
    if (options.requireToken && request.headers.authorization !== `Bearer ${options.requireToken}`) {
      response.writeHead(401).end();
      return;
    }
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    if (message.method === "tools/list" && options.failTools) { response.writeHead(503).end("unavailable"); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test-mcp", version: "1.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: options.toolName ?? "echo", description: "Return the supplied text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: `received:${message.params?.arguments?.text ?? ""}` }] }
          : {};
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function startLegacySseMcpFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const transports = new Map<string, SSEServerTransport>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/mcp") {
      const transport = new SSEServerTransport("/messages", response);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      const mcp = new McpServer({ name: "legacy-sse-test", version: "1.0" });
      mcp.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `legacy:${text}` }] }));
      await mcp.connect(transport);
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/messages")) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks).toString("utf8");
    const sessionId = new URL(request.url, "http://127.0.0.1").searchParams.get("sessionId");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) { response.writeHead(400).end("Missing SSE session"); return; }
    await transport.handlePostMessage(request, response, JSON.parse(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: async () => { await Promise.all([...transports.values()].map((transport) => transport.close())); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

test.beforeEach(async () => {
  process.env.NODE_ENV = "test";
  await initStore({ memoryOnly: true });
  (config as { mcpEnabled: boolean }).mcpEnabled = true;
  (config as { mcpConnectionEncryptionKey: string }).mcpConnectionEncryptionKey = Buffer.alloc(32, 7).toString("base64url");
});

test.afterEach(async () => {
  await (await import("../src/mcp/client.js")).mcpClient.close();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test("built-in MCP catalog servers are available after account connection", () => {
  const catalog = listMcpCatalog();
  assert.ok(catalog.servers.some((server) => server.id === "context7"));
  const placeholderOwner = { ownerIds: [1] };
  assert.equal(isMcpServerAllowedForUser(placeholderOwner, 7906015891, false), true);
  assert.equal(isMcpServerAllowedForUser(placeholderOwner, 7906015891, true), false);
});

test("MCP registry is owner scoped and rejects unsafe URLs", () => {
  const parsed = parseMcpRegistry(JSON.stringify([{ id: "linear", name: "Linear", url: "https://mcp.example.com/mcp", ownerIds: [42], auth: { type: "bearer", tokenEnv: "MCP_LINEAR_TOKEN" } }]), true);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.servers[0]?.ownerIds, [42]);
  assert.throws(() => validateMcpUrl("http://127.0.0.1:8080/mcp", true), /HTTPS/);
  assert.equal(validateMcpUrl("http://127.0.0.1:8080/mcp", false), "http://127.0.0.1:8080/mcp");
  assert.throws(() => validateMcpUrl("https://user:pass@example.com/mcp", true), /disallowed/);
  assert.throws(() => validateMcpUrl("https://[::1]/mcp", true), /disallowed/);
  assert.throws(() => validateMcpUrl("https://service.internal/mcp", true), /disallowed/);
});

test("MCP catalog definitions support OAuth and bounded scopes", () => {
  const parsed = parseMcpRegistry(JSON.stringify([{ id: "linear", name: "Linear", url: "https://mcp.example.com/mcp", ownerIds: [1], auth: { type: "oauth" }, scopes: ["issues:read", "issues:read", "bad scope"] }]), true);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.servers[0]?.auth?.type, "oauth");
  assert.deepEqual(parsed.servers[0]?.scopes, ["issues:read"]);
});

test("MCP tools receive stable namespaced OpenAI definitions", () => {
  const server = { id: "linear", name: "Linear", url: "https://mcp.example.com/mcp", ownerIds: [42], requireApproval: true } as const;
  const converted = toOpenAITool(server, { name: "search_issues", description: "Search issues", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } });
  assert.ok(converted);
  assert.match(converted.tool.function.name, /^MCP_linear_search_issues_[a-f0-9]{10}$/);
  assert.equal(converted.ref.requireApproval, true);
  assert.throws(() => validateMcpArguments({}, converted.ref.inputSchema), /query is required/);
  validateMcpArguments({ query: "latency" }, converted.ref.inputSchema);
  assert.equal(namespaceMcpTool("linear", "search_issues"), converted.tool.function.name);
});

test("custom MCP add verifies discovery, encrypts credentials, and supports agent tool execution", async () => {
  const fixture = await startMcpFixture({ requireToken: "private-test-token" });
  try {
    const connection = await addCustomMcpServer(501, { name: "Private test server", url: fixture.url, auth: "bearer" }, { accessToken: "private-test-token" });
    assert.equal(connection.name, "Private test server");
    assert.equal(connection.verifiedToolCount, 1);
    const stored = (await getSession(501)).mcpConnections!.find((item) => item.serverId === connection.serverId)!;
    assert.ok(stored.customServer);
    assert.ok(stored.credential);
    assert.equal(JSON.stringify(stored).includes("private-test-token"), false);
    assert.deepEqual((await listMcpCatalogForUser(501)).servers.filter((item) => item.custom).map((item) => item.id), [connection.serverId]);
    const tools = await discoverToolsForUser(501);
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.failures.length, 0);
    const result = await (await import("../src/mcp/client.js")).mcpClient.callTool(501, tools.tools[0]!.function.name, { text: "hello" });
    assert.match(result, /received:hello/);
    assert.deepEqual(await listMcpConnections(502), []);
    assert.deepEqual((await discoverToolsForUser(502)).tools, []);
    assert.equal(await disconnectMcpServer(502, connection.serverId), false);
    assert.equal((await getSession(501)).mcpConnections!.length, 1);
  } finally { await fixture.close(); }
});

test("custom MCP client falls back to the legacy HTTP+SSE transport", async () => {
  const fixture = await startLegacySseMcpFixture();
  try {
    const connection = await addCustomMcpServer(505, { name: "Legacy MCP", url: fixture.url, auth: "none" });
    assert.equal(connection.verifiedToolCount, 1);
    const discovery = await discoverToolsForUser(505);
    assert.equal(discovery.tools.length, 1);
    const result = await (await import("../src/mcp/client.js")).mcpClient.callTool(505, discovery.tools[0]!.function.name, { text: "hello" });
    assert.match(result, /legacy:hello/);
  } finally { await fixture.close(); }
});

test("custom MCP add does not save a server that cannot initialize and list tools", async () => {
  const fixture = await startMcpFixture({ failTools: true });
  try {
    await assert.rejects(addCustomMcpServer(503, { name: "Unavailable", url: fixture.url, auth: "none" }), /discover|connect|MCP/i);
    assert.deepEqual(await listMcpConnections(503), []);
    assert.deepEqual((await listMcpCatalogForUser(503)).servers.filter((item) => item.custom), []);
  } finally { await fixture.close(); }
});

test("MCP connection capacity fails clearly without evicting existing connections", async () => {
  const session = await getSession(507);
  session.mcpConnections = Array.from({ length: 50 }, (_, index) => ({ serverId: `existing-${index}`, enabled: true, createdAt: index + 1, updatedAt: index + 1 }));
  await saveSession(507, session);
  const fixture = await startMcpFixture();
  try {
    await assert.rejects(addCustomMcpServer(507, { name: "Overflow", url: fixture.url, auth: "none" }), /limit of 50 connected MCP servers/);
    assert.equal((await getSession(507)).mcpConnections!.length, 50);
  } finally { await fixture.close(); }
});

test("custom MCP discovery returns a sanitized failure rather than silently hiding it", async () => {
  const fixture = await startMcpFixture();
  try {
    const connection = await addCustomMcpServer(504, { name: "Transient MCP", url: fixture.url, auth: "none" });
    await (await import("../src/mcp/client.js")).mcpClient.invalidate(504, connection.serverId);
    await fixture.close();
    const result = await discoverToolsForUser(504);
    assert.equal(result.tools.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.serverId, connection.serverId);
    assert.ok(result.failures[0]?.message);
    assert.equal(result.failures[0]?.message.includes(fixture.url), false);
  } finally { if (fixture) await fixture.close().catch(() => undefined); }
});

test("namespaced MCP tool names fit provider function-name limits", () => {
  assert.ok(namespaceMcpTool("x".repeat(40), "y".repeat(128)).length <= 64);
});

test("MCP output is bounded and never depends on provider payload formatting", () => {
  assert.equal(normalizeMcpResult({ ok: true }), '{"ok":true}');
  assert.match(normalizeMcpResult("x".repeat(20), 10), /MCP tool output truncated/);
});
