import assert from "node:assert/strict";
import test from "node:test";
import { encodeSessionDomainCache, parseLegacySessionDomainCache, parseSessionDomainCache, sessionDomainCacheKey } from "../src/sessionDomainCache.js";

test("session domain cache keys isolate each owner and domain", () => {
  assert.equal(sessionDomainCacheKey(42, "profile"), "chuck:session-domain:42:profile");
  assert.notEqual(sessionDomainCacheKey(42, "profile"), sessionDomainCacheKey(42, "assets"));
  assert.notEqual(sessionDomainCacheKey(42, "profile"), sessionDomainCacheKey(43, "profile"));
});

test("session domain cache encoding and parsing preserve versioned payloads", () => {
  const encoded = encodeSessionDomainCache({ domain: "conversation", payload: { summaries: ["one"] }, version: 7, updatedAt: 123 });
  assert.ok(encoded);
  assert.deepEqual(parseSessionDomainCache(encoded, "conversation"), { domain: "conversation", payload: { summaries: ["one"] }, version: 7, updatedAt: 123 });
  assert.equal(parseSessionDomainCache(encoded, "assets"), undefined);
  assert.equal(parseSessionDomainCache("not-json", "conversation"), undefined);
});

test("legacy aggregate cache parsing accepts valid domains without trusting malformed entries", () => {
  const parsed = parseLegacySessionDomainCache(JSON.stringify({ documents: [
    ["profile", { domain: "profile", payload: { model: "test/model" }, version: 2, updatedAt: 10 }],
    ["unknown", { domain: "unknown", payload: {}, version: 1, updatedAt: 10 }],
    ["assets", { domain: "assets", payload: {}, version: 0, updatedAt: 10 }],
  ] }));
  assert.deepEqual([...parsed.keys()], ["profile"]);
  assert.equal(parseLegacySessionDomainCache("{}" ).size, 0);
});
