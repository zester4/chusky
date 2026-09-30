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
