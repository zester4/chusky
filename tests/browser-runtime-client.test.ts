import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { DedicatedBrowserRuntimeClient } from "../src/lib/browser-runtime/client.js";

test("dedicated browser client signs owner-scoped requests without exposing provider URLs", async () => {
  const previousFetch = globalThis.fetch;
  const previousNodeEnv = process.env.NODE_ENV;
  let captured: { url: string; init?: RequestInit } | undefined;
  process.env.NODE_ENV = "production";
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ id: "session-1", provider: "kernel" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new DedicatedBrowserRuntimeClient({ baseUrl: "https://browser.example.test/", token: "runtime-token", ownerSigningSecret: "owner-secret" });
    const result = await client.start("account:42", { startUrl: "https://example.com", headful: true });
    assert.equal(result.id, "session-1");
    assert.equal(captured?.url, "https://browser.example.test/v1/sessions");
    const headers = captured?.init?.headers as Record<string, string>;
    const timestamp = headers["x-chusky-owner-timestamp"];
    const expected = createHmac("sha256", "owner-secret").update(`${timestamp}.account:42`).digest("hex");
    assert.equal(headers.authorization, "Bearer runtime-token");
    assert.equal(headers["x-chusky-owner-signature"], expected);
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), { startUrl: "https://example.com", headful: true });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
