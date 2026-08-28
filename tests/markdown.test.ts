import test from "node:test";
import assert from "node:assert/strict";
import { mdToTelegramHtml, splitHtml } from "../src/markdown.js";

test("escapes user-controlled HTML", () => {
  assert.equal(mdToTelegramHtml("<script>alert(1)</script> & ok"), "&lt;script&gt;alert(1)&lt;/script&gt; &amp; ok");
});

test("converts common markdown", () => {
  const html = mdToTelegramHtml("**bold** and `code`\n\n- item");
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /• item/);
});

test("keeps short messages as one chunk", () => {
  assert.deepEqual(splitHtml("hello"), ["hello"]);
});

test("splits long paragraphs within the configured bound", () => {
  const chunks = splitHtml("x".repeat(101), 40);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
});
