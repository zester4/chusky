import test from "node:test";
import assert from "node:assert/strict";
import { createBlandConsultToolDefinition, provisionBlandConsultTool } from "../src/calls/blandTool.js";

const secret = "a-production-like-shared-tool-secret-with-entropy";

test("Bland custom consultation tool uses the documented v1 tool schema and stable URL", () => {
  const tool = createBlandConsultToolDefinition("https://chusky.example/bland/webhook", secret);
  assert.equal(tool.url, "https://chusky.example/bland/tool");
  assert.equal(tool.method, "POST");
  assert.equal(tool.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(tool.body, { call_id: "{{call_id}}", question: "{{input.question}}" });
  assert.deepEqual(tool.response, { answer: "$.answer" });
  assert.deepEqual(tool.input_schema.required, ["question"]);
});

test("Bland custom tool provisioning returns only a valid TL tool ID", async () => {
  let request: { url: string; body: Record<string, unknown> } | undefined;
  const id = await provisionBlandConsultTool({
    apiKey: "test-api-key", webhookUrl: "https://chusky.example/bland/webhook", secret,
    fetchImpl: async (url, init) => {
      request = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ status: "success", tool_id: "TL-1234567890" }), { status: 200 });
    },
  });
  assert.equal(id, "TL-1234567890");
  assert.equal(request?.url, "https://api.bland.ai/v1/tools");
  assert.equal((request?.body.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
});

test("Bland custom tool provisioning fails closed on bad secrets, URLs, and provider responses", async () => {
  assert.throws(() => createBlandConsultToolDefinition("https://chusky.example", "short"), /BLAND_CONSULT_TOOL_SECRET/);
  assert.throws(() => createBlandConsultToolDefinition("https://chusky.example", `${secret}\n`), /URL-safe/);
  assert.throws(() => createBlandConsultToolDefinition("http://chusky.example", secret), /HTTPS/);
  await assert.rejects(() => provisionBlandConsultTool({
    apiKey: "test-api-key", webhookUrl: "https://chusky.example/bland/webhook", secret,
    fetchImpl: async () => new Response(JSON.stringify({ status: "success", tool_id: "not-a-tool-id" }), { status: 200 }),
  }), /provisioning failed/);
});
