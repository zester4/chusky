import test from "node:test";
import assert from "node:assert/strict";
import { formatApproval, renderMarkdown } from "../src/cli/renderer.js";

test("terminal renderer keeps Markdown readable without ANSI", () => {
  const output = renderMarkdown("# Hello\n\n**bold** and `code`\n\n- one\n- two\n\n```ts\nconst ok = true;\n```", false);
  assert.equal(output, "Hello\n\nbold and code\n\n• one\n• two\n\n[ts]\nconst ok = true;");
});

test("approval formatter includes exact review identity", () => {
  const output = formatApproval({ id: "appr_1", toolSlug: "GMAIL_SEND_EMAIL", args: { to: "joe@example.com" } });
  assert.match(output, /appr_1/);
  assert.match(output, /GMAIL_SEND_EMAIL/);
  assert.match(output, /joe@example.com/);
});

test("terminal renderer formats tables and rich inline Markdown", () => {
  const output = renderMarkdown("| Model | Status |\n| --- | :---: |\n| **Luna** | ~~old~~ ready |", false);
  assert.match(output, /┌/);
  assert.match(output, /Luna/);
  assert.match(output, /old ready/);
});
