import { mdToTelegramHtml } from "./markdown.js";

const MAX_RICH_HTML = 32_000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function splitCells(line: string): string[] {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let value = "";
  let code = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "`" && source[i - 1] !== "\\") code = !code;
    if (ch === "|" && !code && source[i - 1] !== "\\") {
      cells.push(value.trim().replace(/\\\|/g, "|"));
      value = "";
    } else {
      value += ch;
    }
  }
  cells.push(value.trim().replace(/\\\|/g, "|"));
  return cells;
}

function separator(cell: string): boolean { return /^:?-{3,}:?$/.test(cell.trim()); }

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+•]|\d+[.)])\s+/.test(line);
}

function listItem(line: string): { indent: number; ordered: boolean; content: string } | undefined {
  const match = /^(\s*)([-*+•]|\d+[.)])\s+(.+)$/.exec(line);
  if (!match) return undefined;
  return { indent: match[1].length, ordered: /^\d/.test(match[2]), content: match[3] };
}

function inlineCell(value: string): string {
  return mdToTelegramHtml(value).replace(/\n+/g, " ");
}

function inline(value: string): string {
  return mdToTelegramHtml(value).replace(/\n/g, "<br>");
}

function tableAt(lines: string[], index: number): { headers: string[]; rows: string[][]; next: number } | undefined {
  if (!lines[index]?.includes("|")) return undefined;
  const headers = splitCells(lines[index]);
  const divider = lines[index + 1]?.includes("|") ? splitCells(lines[index + 1]) : [];
  if (!headers.length || headers.length !== divider.length || !divider.every(separator)) return undefined;

  const rows: string[][] = [];
  let next = index + 2;
  while (next < lines.length && lines[next].includes("|")) {
    const row = splitCells(lines[next]);
    if (row.length !== headers.length) break;
    rows.push(row);
    next++;
  }
  return { headers, rows, next };
}

function renderTable(table: { headers: string[]; rows: string[][] }): string {
  const header = `<tr>${table.headers.map((cell) => `<th>${inlineCell(cell)}</th>`).join("")}</tr>`;
  const rows = table.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineCell(cell)}</td>`).join("")}</tr>`).join("");
  return `<table bordered striped>${header}${rows}</table>`;
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = listItem(lines[start]);
  if (!first) return { html: "", next: start };

  const items: string[][] = [];
  const baseIndent = first.indent;
  const ordered = first.ordered;
  let current: string[] | undefined;
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    const marker = listItem(line);

    if (!line.trim()) {
      const next = listItem(lines[index + 1] ?? "");
      if (current && next && next.indent >= baseIndent && next.ordered === ordered) {
        index++;
        continue;
      }
      break;
    }

    if (marker) {
      if (marker.indent < baseIndent || (marker.indent === baseIndent && marker.ordered !== ordered)) break;
      if (marker.indent === baseIndent) {
        if (current) items.push(current);
        current = [marker.content];
      } else if (current) {
        // Keep nested items visible without flattening the parent item into a
        // paragraph. Telegram Rich HTML supports nested list blocks, but a
        // simple bullet continuation is more reliable across older clients.
        current.push(`• ${marker.content}`);
      }
      index++;
      continue;
    }

    if (!current) break;
    current.push(line.trim());
    index++;
  }
  if (current) items.push(current);

  const tag = ordered ? "ol" : "ul";
  const html = `<${tag}>${items.map((item) => `<li>${item.map((line, itemIndex) => `${itemIndex ? "<br>" : ""}${inline(line)}`).join("")}</li>`).join("")}</${tag}>`;
  return { html, next: index };
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*```/.test(line) || /^#{1,6}[ \t]+/.test(line) || /^[-*_]{3,}\s*$/.test(line) || /^\s*>/.test(line) || isListItem(line) || Boolean(tableAt(lines, index));
}

function renderRichBlocks(lines: string[]): { html: string; hasTable: boolean; ambiguous: boolean } {
  const blocks: string[] = [];
  let hasTable = false;
  let ambiguous = false;

  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(lines[index]);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const table = tableAt(lines, index);
    if (table) {
      if (isListItem(lines[table.next] ?? "")) ambiguous = true;
      blocks.push(renderTable(table));
      hasTable = true;
      index = table.next;
      continue;
    }

    const heading = /^(#{1,6})[ \t]+(.+)$/.exec(lines[index]);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      index++;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(lines[index])) {
      blocks.push("<hr/>");
      index++;
      continue;
    }

    if (/^\s*>/.test(lines[index])) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (isListItem(lines[index])) {
      const list = renderList(lines, index);
      if (list.html) blocks.push(list.html);
      index = list.next > index ? list.next : index + 1;
      continue;
    }

    const paragraph: string[] = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++]);
    blocks.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }

  return { html: blocks.join(""), hasTable, ambiguous };
}

export interface RichTelegramResult { hasTable: boolean; html: string; safe: boolean; }

export function markdownToTelegramRichHtml(markdown: string): RichTelegramResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const rendered = renderRichBlocks(lines);

  if (rendered.ambiguous || !rendered.hasTable) {
    return { hasTable: false, html: mdToTelegramHtml(markdown), safe: false };
  }

  const html = rendered.html.trim();
  return { hasTable: rendered.hasTable, html, safe: rendered.hasTable && html.length <= MAX_RICH_HTML };
}
