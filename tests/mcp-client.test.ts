import assert from "node:assert/strict";
import test from "node:test";
import { namespaceMcpTool, normalizeMcpResult, parseMcpRegistry, toOpenAITool, validateMcpArguments, validateMcpUrl } from "../src/mcp/client.js";

test("MCP registry is owner scoped and rejects unsafe URLs", () => {
  const parsed = parseMcpRegistry(JSON.stringify([{ id: "linear", name: "Linear", url: "https://mcp.example.com/mcp", ownerIds: [42], auth: { type: "bearer", tokenEnv: "MCP_LINEAR_TOKEN" } }]), true);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.servers[0]?.ownerIds, [42]);
  assert.throws(() => validateMcpUrl("http://127.0.0.1:8080/mcp", true), /HTTPS/);
  assert.equal(validateMcpUrl("http://127.0.0.1:8080/mcp", false), "http://127.0.0.1:8080/mcp");
  assert.throws(() => validateMcpUrl("https://user:pass@example.com/mcp", true), /disallowed/);
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

test("MCP output is bounded and never depends on provider payload formatting", () => {
  assert.equal(normalizeMcpResult({ ok: true }), '{"ok":true}');
  assert.match(normalizeMcpResult("x".repeat(20), 10), /MCP tool output truncated/);
});
