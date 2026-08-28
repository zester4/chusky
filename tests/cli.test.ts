import test from "node:test";
import assert from "node:assert/strict";
import { formatApproval, formatError, formatSessionBanner, formatSuccess, formatToolSummary, renderMarkdown } from "../src/cli/renderer.js";

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

test("terminal renderer adds distinct ANSI colors only when enabled", () => {
  const output = formatSessionBanner("test/model", 42, "laptop", true);
  assert.match(output, /\u001b\[/);
  assert.match(formatSuccess("saved", true), /✓/);
  assert.match(formatError("failed", true), /✗/);
  assert.match(formatToolSummary(["GITHUB_LIST_REPOS"], 0.0012, true), /1 tool/);
  assert.doesNotMatch(formatSessionBanner("test/model", 42, "laptop", false), /\u001b\[/);
});

test("colored Markdown tables keep visible columns aligned", () => {
  const output = renderMarkdown("| Model | Status |\n| --- | --- |\n| **Luna** | ready |", true);
  const visible = output.replace(/\u001b\[[0-9;]*m/g, "");
  const rows = visible.split("\n");
  assert.match(visible, /Luna/);
  assert.match(visible, /ready/);
  assert.equal(rows[0].length, rows[3].length);
});

test("terminal renderer removes emphasis markers and renders horizontal rules", () => {
  const output = renderMarkdown('Subject: *"Aug 28 Brief"*\n\n---\n\n**Important** update', false);
  assert.equal(output, 'Subject: "Aug 28 Brief"\n\n────────────────────────\n\nImportant update');
  assert.doesNotMatch(output, /[*_~]/);
});

test("terminal renderer makes safe links clickable and rejects unsafe schemes", () => {
  const output = renderMarkdown("[Open Gmail](https://mail.google.com/inbox)", true);
  assert.match(output, /Open Gmail/);
  assert.match(output, /\u001b\]8;;https:\/\/mail\.google\.com\/inbox/);
  assert.doesNotMatch(renderMarkdown("[Bad](javascript:alert(1))", true), /\u001b\]8;;/);
  assert.match(renderMarkdown("[Open Gmail](https://mail.google.com/inbox)", false), /Open Gmail \(https:\/\/mail\.google\.com\/inbox\)/);
});

test("terminal tables wrap long cells to the terminal width", () => {
  const previousColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: 50, configurable: true });
  try {
    const output = renderMarkdown("| Plan | Key features |\n| --- | --- |\n| Free | Basic store, marketplace listing, buyer checkout, analytics, exports, and support |", false);
    const lines = output.split("\n");
    assert.ok(lines.length > 5);
    assert.ok(lines.every((line) => line.length <= 50));
    assert.match(output, /buyer checkout/);
    assert.match(output, /└/);
  } finally { Object.defineProperty(process.stdout, "columns", { value: previousColumns, configurable: true }); }
});
