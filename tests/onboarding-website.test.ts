import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicWebsiteText, fetchPublicWebsite, normalizePublicWebsiteUrl } from "../src/onboardingWebsite.js";

test("normalizes bare onboarding website hosts without changing explicit schemes", () => {
  assert.equal(normalizePublicWebsiteUrl(" example.com "), "https://example.com");
  assert.equal(normalizePublicWebsiteUrl("https://example.com/about"), "https://example.com/about");
});

test("extracts bounded readable text and removes executable page content", () => {
  const result = extractPublicWebsiteText("<title>Acme</title><script>ignore()</script><main><h1>Acme Studio</h1><p>We build useful tools &amp; services.</p></main>", "text/html; charset=utf-8");
  assert.equal(result.title, "Acme");
  assert.match(result.text, /Acme Studio/);
  assert.match(result.text, /useful tools & services/);
  assert.doesNotMatch(result.text, /ignore/);
});

test("fetches public HTML with a bounded manual redirect chain", async () => {
  const calls: string[] = [];
  const validateUrl = async (value: string) => new URL(value);
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/home" } });
    return new Response("<html><title>Example</title><main><h1>Example company</h1><p>Public information.</p></main></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const result = await fetchPublicWebsite("example.com", undefined, fetcher, validateUrl);
  assert.equal(result.finalUrl, "https://example.com/home");
  assert.match(result.text, /Example company/);
  assert.deepEqual(calls, ["https://example.com/", "https://example.com/home"]);
});
