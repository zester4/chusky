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

test("TinyFish search applies an optional result limit locally without changing provider parameters", async () => {
  let requestedUrl = "";
  const client = createTinyFishClient("server-secret", async (input) => {
    requestedUrl = String(input);
    return Response.json({ results: Array.from({ length: 8 }, (_, position) => ({ position, title: `Result ${position}` })) });
  });

  const result = await client.search({ query: "news", limit: 3 });
  assert.equal(new URL(requestedUrl).searchParams.has("limit"), false);
  assert.equal(result.results.length, 3);
  await assert.rejects(() => client.search({ query: "news", limit: 9 }), /limit must be an integer from 1 to 8/i);
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

test("TinyFish search ignores blank optional filters and reports an actionable location limit", async () => {
  let requestUrl = "";
  const client = createTinyFishClient("server-secret", async (input) => {
    requestUrl = String(input);
    return Response.json({ results: [] });
  });
  await client.search({ query: "latest product updates", location: "  ", language: "", purpose: " ", afterDate: "", beforeDate: "" });
  const params = new URL(requestUrl).searchParams;
  for (const field of ["location", "language", "purpose", "after_date", "before_date"]) assert.equal(params.has(field), false, `${field} should be omitted when blank`);
  await assert.rejects(() => client.search({ query: "latest product updates", location: "x".repeat(101) }), /location.*100 characters/i);
});

test("TinyFish search supports source filters and publication metadata", async () => {
  let requestUrl = "";
  const client = createTinyFishClient("server-secret", async (input) => {
    requestUrl = String(input);
    return Response.json({ results: [{ title: "Paper", url: "https://example.org/paper", authors: ["A. Author"], venue: "Journal", year: 2025, cited_by_count: 7 }] });
  });
  const result = await client.search({ query: "agents", purpose: "Find peer-reviewed agent evaluations", includeDomains: ["arxiv.org"], excludeDomains: ["example.com"], domainType: "research_paper", pubYearMin: 2020, pubYearMax: 2025 });
  const params = new URL(requestUrl).searchParams;
  assert.equal(params.get("purpose"), "Find peer-reviewed agent evaluations");
  assert.equal(params.get("include_domains"), "arxiv.org");
  assert.equal(params.get("exclude_domains"), "example.com");
  assert.equal(params.get("domain_type"), "research_paper");
  assert.equal(params.get("pub_year_min"), "2020");
  assert.equal(result.results[0]?.citation_count, 7);
});

test("TinyFish Fetch exposes extraction controls and supports ten URLs", async () => {
  let body: Record<string, unknown> = {};
  const client = createTinyFishClient("server-secret", async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ results: [{ url: "https://example.com", text: null, not_modified: true, highlights: [{ text: "Relevant", rank: 1 }] }], errors: [] });
  });
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  const result = await client.fetch({ urls, ttl: 0, perUrlTimeoutMs: 90_000, includeEtagAndLastModified: true, includeSelectors: ["main"], excludeSelectors: ["nav"], highlights: { query: "release date", maxCount: 3, maxCharacters: 2_000 } });
  assert.equal((body.urls as string[]).length, 10);
  assert.equal(body.per_url_timeout_ms, 90_000);
  assert.deepEqual(body.highlights, { query: "release date", max_snippets: 3, max_characters: 2_000 });
  assert.equal(result.results[0]?.not_modified, true);
  assert.equal(result.results[0]?.highlights?.[0]?.text, "Relevant");
});

test("TinyFish Research persists the run id before returning a cited, browser-free report", async () => {
  let body: Record<string, unknown> = {};
  let savedRunId = "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"event":"created","research_run_id":"run-1"}\n\n'));
      controller.enqueue(encoder.encode('data: {"event":"final_result","result":"A cited report","citations":[{"url":"https://example.org","title":"Source"}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"event":"done"}\n\n'));
      controller.close();
    },
  });
  const client = createTinyFishClient("server-secret", async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  const result = await client.research({ query: "Compare current policies", mode: "deep", onRunCreated: async (id) => { savedRunId = id; } });
  assert.equal(body.mode, "deep");
  assert.equal(Object.hasOwn(body, "browser_enabled"), false);
  assert.equal(body.stream, false);
  assert.equal(savedRunId, "run-1");
  assert.equal(result.result, "A cited report");
  assert.deepEqual(result.citations, [{ url: "https://example.org/", title: "Source", snippet: undefined }]);
});

test("TinyFish Research start returns at the saved run ID and closes the provider event stream", async () => {
  const encoder = new TextEncoder();
  let streamCancelled = false;
  let savedId = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: {"event":"created","research_run_id":"run-async"}\n\n')); },
    cancel() { streamCancelled = true; },
  });
  const client = createTinyFishClient("server-secret", async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const result = await client.startResearch({ query: "Find official sources", onRunCreated: async (id) => { savedId = id; } });
  assert.equal(savedId, "run-async");
  assert.equal(result.researchRunId, "run-async");
  assert.equal(streamCancelled, true);
});

test("TinyFish Monitor lifecycle uses the current Monitor API host and owner-supplied public callback", async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown>; auth: string }> = [];
  const client = createTinyFishClient("server-secret", async (input, init) => {
    requests.push({
      url: String(input), method: String(init?.method),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      auth: new Headers(init?.headers).get("X-API-Key") ?? "",
    });
    if (init?.method === "POST") return Response.json({ monitor: { id: "monitor-1" }, run: { id: "baseline-1" } }, { status: 201 });
    if (init?.method === "PATCH") return Response.json({ monitor: { id: "monitor-1", status: "paused" } });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ monitor: { id: "monitor-1", status: "active" } });
  });
  await client.createMonitor({ type: "fetch", name: "Pricing", config: { url: "https://example.org/pricing" }, schedule_cron: "0 9 * * *", webhook_url: "https://chusky.example/tinyfish/monitor/callback" });
  await client.getMonitor("monitor-1");
  await client.updateMonitor("monitor-1", { status: "paused" });
  await client.deleteMonitor("monitor-1");
  assert.equal(requests.every((request) => request.url.startsWith("https://agent.tinyfish.chat/v1/monitors")), true);
  assert.equal(requests.every((request) => request.auth === "server-secret"), true);
  assert.equal((requests[0]?.body?.webhook_url as string).startsWith("https://chusky.example/"), true);
});
