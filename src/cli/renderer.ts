const ESC = "\u001b[";
const ansi = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, underline: `${ESC}4m`,
  red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`, blue: `${ESC}34m`,
  magenta: `${ESC}35m`, cyan: `${ESC}36m`, white: `${ESC}37m`,
};
const ansiPattern = /(?:\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007]*\u0007|\u001b\]8;;\u0007)/g;

export type CliColor = "dim" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

export function paint(text: string, color: CliColor, enabled = process.stdout.isTTY === true): string {
  return enabled ? `${ansi[color]}${text}${ansi.reset}` : text;
}

function visibleLength(text: string): number { return text.replace(ansiPattern, "").length; }
function padVisible(text: string, width: number): string { return text + " ".repeat(Math.max(0, width - visibleLength(text))); }

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function wrapTableCell(value: string, width: number): string[] {
  if (!value) return [""];
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      if (word.length <= width) current = word;
      else for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word.length <= width ? word : ""; if (!current) for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width)); }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function renderTable(rawRows: string[], color: boolean): string[] {
  const plainRows = rawRows.map(tableCells).map((cells) => cells.map((cell) => inline(cell, false)));
  const columnCount = Math.max(...plainRows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) => Math.max(1, ...plainRows.map((row) => visibleLength(row[column] ?? ""))));
  const terminalWidth = Math.max(40, (process.stdout.columns || 100) - 2);
  const separatorWidth = columnCount * 3 + 1;
  const minimumWidth = 8;
  while (widths.reduce((sum, width) => sum + width, 0) + separatorWidth > terminalWidth) {
    const largest = widths.indexOf(Math.max(...widths));
    if (widths[largest] <= minimumWidth) break;
    widths[largest]--;
  }
  const border = (left: string, middle: string, right: string) => `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const output = [border("┌", "┬", "┐")];
  for (let rowIndex = 0; rowIndex < plainRows.length; rowIndex++) {
    const row = plainRows[rowIndex];
    const wrapped = row.map((cell, column) => wrapTableCell(cell, widths[column]));
    const rowHeight = Math.max(...wrapped.map((cell) => cell.length));
    for (let line = 0; line < rowHeight; line++) {
      output.push(`│ ${wrapped.map((cell, column) => padVisible(inline(cell[line] ?? "", color), widths[column])).join(" │ ")} │`);
    }
    if (rowIndex === 0) output.push(border("├", "┼", "┤"));
  }
  output.push(border("└", "┴", "┘"));
  return output;
}

export function formatSessionBanner(model: string, userId: number, device: string, color = process.stdout.isTTY === true): string {
  const title = paint("Chusky", "cyan", color);
  return `${title}  ${paint("●", "green", color)}  ${model}\n${paint(`Shared session  •  user ${userId}  •  ${device}`, "dim", color)}`;
}

export function formatStatus(label: string, message: string, color = process.stdout.isTTY === true): string {
  return `${paint(label, "cyan", color)} ${paint(message, "dim", color)}`;
}

export function formatSuccess(message: string, color = process.stdout.isTTY === true): string {
  return `${paint("✓", "green", color)} ${message}`;
}

export function formatError(message: string, color = process.stdout.isTTY === true): string {
  return `${paint("✗", "red", color)} ${message}`;
}

export function formatWarning(message: string, color = process.stdout.isTTY === true): string {
  return `${paint("!", "yellow", color)} ${message}`;
}

export function formatToolSummary(tools: string[], cost: number | undefined, color = process.stdout.isTTY === true): string {
  const details = [
    tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "no tools",
    typeof cost === "number" ? `$${cost.toFixed(5)}` : undefined,
  ].filter(Boolean).join("  •  ");
  return formatStatus("Done", details, color);
}

function inline(text: string, color: boolean): string {
  let out = text.replace(/\\([*_`\[\]\\])/g, "$1");
  const link = (_match: string, label: string, target: string) => {
    const url = target.trim();
    if (!/^https?:\/\//i.test(url) || /[\u001b\u0007]/.test(url)) return `${label} (${url})`;
    if (!color) return `${label} (${url})`;
    return `\u001b]8;;${url}\u0007${ansi.underline}${ansi.blue}${label}${ansi.reset}\u001b]8;;\u0007`;
  };
  if (!color) {
    return out.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, link).replace(/(?<!\w)\*+(?=\S)/g, "").replace(/(?<=\S)\*+(?=\s|$)/g, "");
  }
  out = out.replace(/`([^`]+)`/g, `${ansi.cyan}$1${ansi.reset}`);
  out = out.replace(/\*\*([^*]+)\*\*/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/__([^_]+)__/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/~~([^~]+)~~/g, `${ansi.dim}$1${ansi.reset}`);
  out = out.replace(/\*([^*]+)\*/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/_([^_]+)_/g, `${ansi.dim}$1${ansi.reset}`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, link);
  // Models occasionally emit unmatched emphasis markers around quoted text.
  // They are formatting noise in a terminal, so never leave lone stars behind.
  out = out.replace(/(?<!\w)\*+(?=\S)/g, "").replace(/(?<=\S)\*+(?=\s|$)/g, "");
  return out;
}

export function renderMarkdown(markdown: string, color = process.stdout.isTTY === true): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inCode = false;
  const isTableDelimiter = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) {
      inCode = !inCode;
      if (inCode) output.push(color ? `${ansi.dim}${fence[1] ? `[${fence[1]}]` : ""}${ansi.reset}` : fence[1] ? `[${fence[1]}]` : "");
      continue;
    }
    if (inCode) { output.push(color ? `${ansi.dim}${raw}${ansi.reset}` : raw); continue; }
    if (raw.includes("|") && isTableDelimiter(lines[lineIndex + 1] ?? "")) {
      const tableRows = [raw];
      let tableEnd = lineIndex + 2;
      while (tableEnd < lines.length && lines[tableEnd].includes("|") && !isTableDelimiter(lines[tableEnd])) tableRows.push(lines[tableEnd++]);
      output.push(...renderTable(tableRows, color));
      lineIndex = tableEnd - 1;
      continue;
    }
    if (isTableDelimiter(raw)) continue;
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(raw)) { output.push(color ? `${ansi.dim}────────────────────────${ansi.reset}` : "────────────────────────"); continue; }
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) { output.push(color ? `${ansi.bold}${ansi.green}${heading[1]}${ansi.reset}` : heading[1]); continue; }
    const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { output.push(`• ${inline(bullet[1], color)}`); continue; }
    const numbered = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) { output.push(`${numbered[1]}. ${inline(numbered[2], color)}`); continue; }
    if (/^\s*>/.test(raw)) { const quote = raw.replace(/^\s*>\s?/, ""); output.push(color ? `${ansi.dim}│ ${inline(quote, color)}${ansi.reset}` : `│ ${quote}`); continue; }
    output.push(inline(raw, color));
  }
  return output.join("\n").trimEnd();
}

export function formatApproval(approval: { id: string; toolSlug: string; args: Record<string, unknown> }, color = false): string {
  const args = JSON.stringify(approval.args, null, 2);
  return `${paint("Approval required", "yellow", color)}\n\n${paint("Tool:", "magenta", color)} ${approval.toolSlug}\n${paint("Approval:", "magenta", color)} ${approval.id}\n${paint("Arguments:", "magenta", color)}\n${color ? `${ansi.dim}${args}${ansi.reset}` : args}\n\nType ${paint(`/approve ${approval.id}`, "green", color)} or ${paint(`/deny ${approval.id}`, "red", color)}.`;
}
