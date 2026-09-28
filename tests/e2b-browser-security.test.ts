import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeBrowserUrl } from "../src/lib/e2b/urlSafety.js";

test("browser URL policy allows public HTTP(S) destinations", async () => {
  assert.equal((await assertSafeBrowserUrl("https://example.com/help", { resolveDns: false })).origin, "https://example.com");
});

test("browser URL policy blocks local, private, metadata, and credential-bearing destinations", async () => {
  for (const value of [
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "http://10.0.0.5",
    "http://203.0.113.10",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal",
    "https://user:password@example.com",
  ]) {
    await assert.rejects(() => assertSafeBrowserUrl(value, { resolveDns: false }), /blocked|credentials|private|local/i, value);
  }
});

test("browser URL policy fails closed when a public hostname cannot be resolved", async () => {
  await assert.rejects(() => assertSafeBrowserUrl("https://this-host-should-not-exist.invalid"), /resolved safely/i);
});
