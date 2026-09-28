import test from "node:test";
import assert from "node:assert/strict";
import { createTinyFishClient } from "../src/tinyfish.js";

test("TinyFish search sends server auth and returns bounded source results", async () => {
  let requestedUrl = "";
  let auth = "";
  const client = createTinyFishClient("server-secret", async (input, init) => {
    requestedUrl = String(input);
    auth = new Headers(init?.headers).get("X-API-Key") ?? "";
    return Response.json({ query: "latest AI news", total_results: 99, page: 1, results: Array.from({ length: 12 }, (_, position) => ({ position, title: "T".repeat(600), snippet: "S".repeat(2500), url: `https://example.com/${position}` })) });
  });

  const result = await client.search({ query: " latest AI news ", location: "Ghana", afterDate: "2026-09-01", beforeDate: "2026-09-28", page: 1 });
  const params = new URL(requestedUrl).searchParams;
  assert.equal(auth, "server-secret");
  assert.equal(params.get("query"), "latest AI news");
  assert.equal(params.get("location"), "Ghana");
  assert.equal(params.get("after_date"), "2026-09-01");
  assert.equal(result.results.length, 8);
  assert.equal(result.results[0]?.title?.length, 500);
  assert.equal(result.results[0]?.snippet?.length, 2_000);
  assert.equal(JSON.stringify(result).includes("server-secret"), false);
});

test("TinyFish fetch rejects local URLs and bounds per-page and total extracted text", async () => {
  let requestBody: Record<string, unknown> = {};
  const client = createTinyFishClient("server-secret", async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      results: [
        { url: "https://example.com/1", final_url: "https://example.com/1", text: "A".repeat(9_000), format: "markdown" },
        { url: "https://example.com/2", text: "B".repeat(20_000), format: "markdown" },
      ],
      errors: [{ url: "https://example.com/bad", error: "not available", status: 404 }],
    });
  });
  await assert.rejects(() => client.fetch({ urls: ["http://127.0.0.1/admin"] }), /public http\(s\)/i);
  const result = await client.fetch({ urls: ["https://example.com/1", "https://example.com/2"], links: true });
  assert.deepEqual(requestBody.urls, ["https://example.com/1", "https://example.com/2"]);
  assert.equal(requestBody.links, true);
  assert.equal(result.results[0]?.text.length, 8_000);
  assert.equal(result.results[1]?.text.length, 8_000);
  assert.equal(result.results[1]?.truncated, true);
  assert.equal(result.contentIsUntrusted, true);
});

test("TinyFish search rejects conflicting or invalid date filters", async () => {
  const client = createTinyFishClient("server-secret", async () => Response.json({ results: [] }));
  await assert.rejects(() => client.search({ query: "news", recencyMinutes: 60, afterDate: "2026-09-01" }), /not both/i);
  await assert.rejects(() => client.search({ query: "news", afterDate: "2026-02-30" }), /valid YYYY-MM-DD/i);
  await assert.rejects(() => client.search({ query: "news", afterDate: "2026-09-20", beforeDate: "2026-09-01" }), /on or before/i);
});
