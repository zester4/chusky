import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { nativeTool } from "../src/nativeTools.js";

test("native TinyFish Search treats blank optional model arguments as omitted", async (t) => {
  const originalApiKey = config.tinyFishApiKey;
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  config.tinyFishApiKey = "test-tinyfish-key";
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return Response.json({ results: [] });
  }) as typeof fetch;
  t.after(() => {
    config.tinyFishApiKey = originalApiKey;
    globalThis.fetch = originalFetch;
  });

  await nativeTool(7654321, "CHUCK_TINYFISH_SEARCH", {
    query: "latest product updates",
    location: "",
    language: " ",
    purpose: "",
    afterDate: "",
    beforeDate: "  ",
  });

  const params = new URL(requestUrl).searchParams;
  for (const field of ["location", "language", "purpose", "after_date", "before_date"]) {
    assert.equal(params.has(field), false, `${field} should not be sent when blank`);
  }
});

test("native TinyFish Search accepts a result limit and returns only that many results", async (t) => {
  const originalApiKey = config.tinyFishApiKey;
  const originalFetch = globalThis.fetch;
  config.tinyFishApiKey = "test-tinyfish-key";
  globalThis.fetch = (async () => Response.json({ results: Array.from({ length: 8 }, (_, position) => ({ position, title: `Result ${position}` })) })) as typeof fetch;
  t.after(() => {
    config.tinyFishApiKey = originalApiKey;
    globalThis.fetch = originalFetch;
  });

  const result = await nativeTool(7654322, "CHUCK_TINYFISH_SEARCH", { query: "latest product updates", limit: 2 }) as { results: unknown[] };
  assert.equal(result.results.length, 2);
});
