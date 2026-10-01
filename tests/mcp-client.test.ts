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
import { decryptCredential, encryptCredential } from "../src/vault/crypto.js";
import { refreshMcpOAuthToken } from "../src/mcp/oauthRefresh.js";
const originalNodeEnv = process.env.NODE_ENV;

async function startMcpFixture(options: { requireToken?: string | string[]; requiredHeaders?: Record<string, string>; toolName?: string; failTools?: boolean } = {}): Promise<{ url: string; close: () => Promise<void>; requestCount: () => number; authorizationHeaders: () => string[] }> {
  let requestCount = 0;
  const authorizationHeaders: string[] = [];
  const server: Server = createServer(async (request, response) => {
    requestCount += 1;
    if (typeof request.headers.authorization === "string") authorizationHeaders.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks).toString("utf8");
    if (!payload) { response.writeHead(202).end(); return; }
    const message = JSON.parse(payload) as { id?: string | number; method?: string; params?: { arguments?: { text?: string } } };
    const acceptedTokens = options.requireToken === undefined ? undefined : Array.isArray(options.requireToken) ? options.requireToken : [options.requireToken];
    if (acceptedTokens && !acceptedTokens.some((token) => request.headers.authorization === `Bearer ${token}`)) {
      response.writeHead(401).end();
      return;
    }
    if (options.requiredHeaders && Object.entries(options.requiredHeaders).some(([name, value]) => request.headers[name.toLowerCase()] !== value)) { response.writeHead(401).end(); return; }
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
  return { url: `http://127.0.0.1:${address.port}/mcp`, requestCount: () => requestCount, authorizationHeaders: () => [...authorizationHeaders], close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
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
  const requestedServers = new Map(catalog.servers.map((server) => [server.id, server]));
  assert.deepEqual(
    ["zomato", "instacart_direct", "upscrape"].map((id) => requestedServers.get(id)?.url),
    [
      "https://mcp-server.zomato.com/mcp",
      "https://mcp.instacart.com/mcp",
      "https://data.upscrape.com/mcp",
    ],
  );
  assert.equal(requestedServers.get("zomato")?.auth, "oauth");
  assert.equal(requestedServers.get("zomato")?.enabled, false);
  assert.equal(requestedServers.get("instacart_direct")?.auth, "oauth");
  assert.equal(requestedServers.get("upscrape")?.auth, "oauth");
  assert.equal(requestedServers.get("instacart_direct")?.requireApproval, true);
  assert.equal(requestedServers.get("upscrape")?.requireApproval, true);
  assert.deepEqual(
    ["mercury", "plaid_dashboard", "sabre"].map((id) => {
      const server = requestedServers.get(id);
      return server && { url: server.url, auth: server.auth, enabled: server.enabled, requireApproval: server.requireApproval };
    }),
    [
      { url: "https://mcp.mercury.com/mcp", auth: "oauth", enabled: undefined, requireApproval: true },
      { url: "https://api.dashboard.plaid.com/mcp/", auth: "bearer", enabled: false, requireApproval: true },
      { url: "https://mcp.sabre.com/mcp", auth: "bearer", enabled: false, requireApproval: true },
    ],
  );
  assert.deepEqual(
    ["aws", "gcp_bigquery", "twilio", "vonage_tooling", "etsy"].map((id) => {
      const server = requestedServers.get(id);
      return server && { url: server.url, auth: server.auth, enabled: server.enabled, requireApproval: server.requireApproval };
    }),
    [
      { url: "https://aws-mcp.us-east-1.api.aws/mcp", auth: "oauth", enabled: false, requireApproval: true },
      { url: "https://bigquery.googleapis.com/mcp", auth: "oauth", enabled: false, requireApproval: true },
      { url: "https://mcp.twilio.com/docs", auth: "none", enabled: undefined, requireApproval: false },
      { url: "https://vcr-mcp.use1.runtime.vonage.cloud/mcp", auth: "headers", enabled: undefined, requireApproval: true },
      { url: "https://mcp.api.etsycloud.com/mcp", auth: "none", enabled: undefined, requireApproval: false },
    ],
  );
  assert.deepEqual(requestedServers.get("vonage_tooling")?.authHeaders, ["X-Account-ID", "X-Account-Secret", "X-Region"]);
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

test("MCP catalog header auth only permits curated X-prefixed names", () => {
  const safe = parseMcpRegistry(JSON.stringify([{ id: "vonage", name: "Vonage", url: "https://mcp.example.test/mcp", ownerIds: [1], auth: { type: "headers", headerNames: ["X-Account-ID", "X-Account-Secret", "X-Region"] } }]), true);
  assert.equal(safe.errors.length, 0);
  assert.deepEqual(safe.servers[0]?.auth, { type: "headers", headerNames: ["X-Account-ID", "X-Account-Secret", "X-Region"] });
  for (const headerNames of [["Authorization"], ["Cookie"], ["Content-Type"], ["X-Allowed", "authorization"]]) {
    const rejected = parseMcpRegistry(JSON.stringify([{ id: "unsafe", name: "Unsafe", url: "https://mcp.example.test/mcp", ownerIds: [1], auth: { type: "headers", headerNames } }]), true);
    assert.equal(rejected.servers.length, 0);
    assert.equal(rejected.errors.length, 1);
  }
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

test("MCP OAuth refresh persists rotated tokens before connecting and does not cross owners", async () => {
  const fixture = await startMcpFixture({ requireToken: "rotated-access" });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(
    JSON.stringify([{ id: "oauth-test", name: "OAuth test", url: fixture.url, ownerIds: [511], auth: { type: "oauth" } }]),
    async ({ state }) => ({ tokens: { access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 }, state }),
  );
  try {
    const stored = await getSession(511);
    stored.mcpConnections = [{
      serverId: "oauth-test", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      credential: encryptCredential({ accessToken: "expired-access", refreshToken: "old-refresh", tokenType: "Bearer", expiresAt: Date.now() - 1, oauth: { redirectUri: "https://chusky.example.test/mcp/oauth/callback", clientInformation: { client_id: "registered-client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY"),
    }];
    await saveSession(511, stored);
    const discovery = await manager.discoverToolsForUser(511);
    assert.equal(discovery.failures.length, 0);
    assert.equal(discovery.tools.length, 1);
    const afterRefresh = (await getSession(511)).mcpConnections![0]!.credential!;
    const rotated = decryptCredential<{ accessToken: string; refreshToken: string; expiresAt: number }>(afterRefresh, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
    assert.equal(rotated.accessToken, "rotated-access");
    assert.equal(rotated.refreshToken, "rotated-refresh");
    assert.ok(rotated.expiresAt > Date.now() + 3_500_000);
    assert.deepEqual((await manager.discoverToolsForUser(512)).tools, []);
    const result = await manager.callTool(511, discovery.tools[0]!.function.name, { text: "after-refresh" });
    assert.match(result, /received:after-refresh/);
  } finally {
    await manager.close();
    await fixture.close();
  }
});

test("MCP OAuth refresh preserves omitted refresh tokens and does not invent an access-token lifetime", async () => {
  const fixture = await startMcpFixture({ requireToken: "refreshed-access" });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(
    JSON.stringify([{ id: "oauth-optional-fields", name: "OAuth optional fields", url: fixture.url, ownerIds: [516], auth: { type: "oauth" } }]),
    async ({ state }) => ({ tokens: { access_token: "refreshed-access", token_type: "Bearer" }, state }),
  );
  try {
    const stored = await getSession(516);
    stored.mcpConnections = [{
      serverId: "oauth-optional-fields", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      credential: encryptCredential({ accessToken: "expired-access", refreshToken: "still-valid-refresh", tokenType: "Bearer", expiresAt: Date.now() - 1, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY"),
    }];
    await saveSession(516, stored);
    const discovery = await manager.discoverToolsForUser(516);
    assert.equal(discovery.failures.length, 0);
    const saved = decryptCredential<{ accessToken: string; refreshToken: string; expiresAt?: number }>((await getSession(516)).mcpConnections![0]!.credential!, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
    assert.equal(saved.accessToken, "refreshed-access");
    assert.equal(saved.refreshToken, "still-valid-refresh");
    assert.equal(saved.expiresAt, undefined);
  } finally {
    await manager.close();
    await fixture.close();
  }
});

test("MCP OAuth refresh cannot overwrite credentials changed during the upstream refresh", async () => {
  const fixture = await startMcpFixture({ requireToken: "reconnected-access" });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(
    JSON.stringify([{ id: "oauth-concurrent-reconnect", name: "OAuth concurrent reconnect", url: fixture.url, ownerIds: [517], auth: { type: "oauth" } }]),
    async ({ state }) => {
      const latest = await getSession(517);
      const connection = latest.mcpConnections!.find((item) => item.serverId === "oauth-concurrent-reconnect")!;
      connection.credential = encryptCredential({ accessToken: "reconnected-access", refreshToken: "reconnected-refresh", expiresAt: Date.now() + 3_600_000, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
      connection.updatedAt += 1;
      await saveSession(517, latest);
      return { tokens: { access_token: "stale-refreshed-access", refresh_token: "stale-refreshed-refresh", token_type: "Bearer", expires_in: 3600 }, state };
    },
  );
  try {
    const stored = await getSession(517);
    stored.mcpConnections = [{
      serverId: "oauth-concurrent-reconnect", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      credential: encryptCredential({ accessToken: "expired-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY"),
    }];
    await saveSession(517, stored);
    const discovery = await manager.discoverToolsForUser(517);
    assert.equal(discovery.failures.length, 0);
    assert.equal(discovery.tools.length, 1);
    const saved = decryptCredential<{ accessToken: string; refreshToken: string }>((await getSession(517)).mcpConnections![0]!.credential!, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
    assert.equal(saved.accessToken, "reconnected-access");
    assert.equal(saved.refreshToken, "reconnected-refresh");
  } finally {
    await manager.close();
    await fixture.close();
  }
});

test("MCP client replaces a cached connection after another process rotates the stored access token", async () => {
  const fixture = await startMcpFixture({ requireToken: ["stale-access", "current-access"] });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(
    JSON.stringify([{ id: "oauth-cross-process", name: "OAuth cross process", url: fixture.url, ownerIds: [518], auth: { type: "oauth" } }]),
  );
  try {
    const stored = await getSession(518);
    stored.mcpConnections = [{
      serverId: "oauth-cross-process", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      credential: encryptCredential({ accessToken: "stale-access", refreshToken: "refresh-token", expiresAt: Date.now() + 3_600_000, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY"),
    }];
    await saveSession(518, stored);
    const first = await manager.discoverToolsForUser(518);
    assert.equal(first.failures.length, 0);
    assert.equal(first.tools.length, 1);
    assert.ok(fixture.authorizationHeaders().length > 0);
    assert.ok(fixture.authorizationHeaders().every((header) => header === "Bearer stale-access"));

    const reconnected = await getSession(518);
    const record = reconnected.mcpConnections!.find((item) => item.serverId === "oauth-cross-process")!;
    record.credential = encryptCredential({ accessToken: "current-access", refreshToken: "rotated-refresh", expiresAt: Date.now() + 3_600_000, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
    record.updatedAt += 1;
    await saveSession(518, reconnected);

    const second = await manager.discoverToolsForUser(518);
    assert.equal(second.failures.length, 0);
    assert.equal(second.tools.length, 1);
    assert.ok(fixture.authorizationHeaders().includes("Bearer current-access"));
  } finally {
    await manager.close();
    await fixture.close();
  }
});

test("MCP OAuth refresher uses the installed SDK and persists the provider's rotated refresh token", async () => {
  let tokenRequest: { url: string; body: URLSearchParams } | undefined;
  const result = await refreshMcpOAuthToken({
    serverUrl: "https://mcp.example.test/mcp",
    scopes: ["read", "offline_access"],
    state: {
      redirectUri: "https://chusky.example.test/mcp/oauth/callback",
      clientInformation: { client_id: "registered-client" },
      discoveryState: {
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: { issuer: "https://auth.example.test", token_endpoint: "https://auth.example.test/token", token_endpoint_auth_methods_supported: ["none"] },
      },
    },
    tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      tokenRequest = { url: String(input), body };
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(tokenRequest?.url, "https://auth.example.test/token");
  assert.equal(tokenRequest?.body.get("grant_type"), "refresh_token");
  assert.equal(tokenRequest?.body.get("refresh_token"), "old-refresh");
  assert.equal(result.tokens.access_token, "new-access");
  assert.equal(result.tokens.refresh_token, "new-refresh");
  assert.equal(result.state.clientInformation.client_id, "registered-client");
});

test("MCP OAuth refresh failure blocks the upstream server request", async () => {
  const fixture = await startMcpFixture({ requireToken: "should-not-be-used" });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(
    JSON.stringify([{ id: "oauth-fail", name: "OAuth fail", url: fixture.url, ownerIds: [513], auth: { type: "oauth" } }]),
    async () => { throw new Error("sensitive refresh failure"); },
  );
  try {
    const stored = await getSession(513);
    stored.mcpConnections = [{
      serverId: "oauth-fail", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      credential: encryptCredential({ accessToken: "expired-access", refreshToken: "private-refresh", expiresAt: Date.now() - 1, oauth: { redirectUri: "https://chusky.example.test/callback", clientInformation: { client_id: "client" } } }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY"),
    }];
    await saveSession(513, stored);
    const result = await manager.discoverToolsForUser(513);
    assert.equal(result.tools.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.message ?? "", /Reconnect this server/);
    assert.equal(result.failures[0]?.message.includes("private-refresh"), false);
    assert.equal(fixture.requestCount(), 0);
  } finally {
    await manager.close();
    await fixture.close();
  }
});

test("MCP catalog-declared authentication headers are encrypted, sent privately, and owner-scoped", async () => {
  const secretHeaders = { "X-Account-ID": "account-test-key", "X-Account-Secret": "private-account-secret", "X-Region": "use1" };
  const fixture = await startMcpFixture({ requiredHeaders: { "x-account-id": secretHeaders["X-Account-ID"], "x-account-secret": secretHeaders["X-Account-Secret"], "x-region": secretHeaders["X-Region"] } });
  const manager = new (await import("../src/mcp/client.js")).McpClientManager(JSON.stringify([{ id: "headers-test", name: "Header test", url: fixture.url, ownerIds: [514], auth: { type: "headers", headerNames: Object.keys(secretHeaders) } }]));
  try {
    const stored = await getSession(514);
    stored.mcpConnections = [{ serverId: "headers-test", enabled: true, createdAt: Date.now(), updatedAt: Date.now(), credential: encryptCredential({ headers: secretHeaders }, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY") }];
    await saveSession(514, stored);
    assert.equal(JSON.stringify(await listMcpCatalogForUser(514)).includes("private-account-secret"), false);
    const result = await manager.discoverToolsForUser(514);
    assert.equal(result.failures.length, 0);
    assert.equal(result.tools.length, 1);
    assert.deepEqual((await manager.discoverToolsForUser(515)).tools, []);
    assert.equal(JSON.stringify(result.tools).includes("private-account-secret"), false);
    const encrypted = (await getSession(514)).mcpConnections![0]!.credential!;
    assert.equal(JSON.stringify(encrypted).includes("private-account-secret"), false);
  } finally {
    await manager.close();
    await fixture.close();
  }
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
