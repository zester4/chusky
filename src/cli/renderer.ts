const ESC = "\u001b[";
const ansi = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, cyan: `${ESC}36m`, yellow: `${ESC}33m`, green: `${ESC}32m`, blue: `${ESC}34m`,
};

function inline(text: string, color: boolean): string {
  let out = text.replace(/\\([*_`\[\]\\])/g, "$1");
  if (!color) {
    return out.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  }
  out = out.replace(/`([^`]+)`/g, `${ansi.cyan}$1${ansi.reset}`);
  out = out.replace(/\*\*([^*]+)\*\*/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/__([^_]+)__/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/~~([^~]+)~~/g, `${ansi.dim}$1${ansi.reset}`);
  out = out.replace(/\*([^*]+)\*/g, `${ansi.bold}$1${ansi.reset}`);
  out = out.replace(/_([^_]+)_/g, `${ansi.dim}$1${ansi.reset}`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 (${ansi.blue}$2${ansi.reset})`);
  return out;
}

export function renderMarkdown(markdown: string, color = process.stdout.isTTY === true): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inCode = false;
  let activeTableWidths: number[] | undefined;
  const isTableDelimiter = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const tableRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => inline(cell.trim(), color));
  const tableWidth = (cells: string[]) => cells.reduce((width, cell) => Math.max(width, cell.replace(/\u001b\[[0-9;]*m/g, "").length), 0);
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
      const header = tableRow(raw); activeTableWidths = header.map((cell) => tableWidth([cell]));
      const separator = `├${activeTableWidths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
      output.push(`┌${activeTableWidths.map((width) => "─".repeat(width + 2)).join("┬")}┐`);
      output.push(`│ ${header.map((cell, i) => cell.padEnd(activeTableWidths![i])).join(" │ ")} │`);
      output.push(separator);
      continue;
    }
    if (activeTableWidths && raw.includes("|") && !isTableDelimiter(raw)) {
      const cells = tableRow(raw);
      if (cells.length > 1) output.push(`│ ${activeTableWidths.map((width, i) => (cells[i] ?? "").padEnd(width)).join(" │ ")} │`);
      continue;
    }
    if (isTableDelimiter(raw)) continue;
    if (!raw.trim()) activeTableWidths = undefined;
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

export function formatApproval(approval: { id: string; toolSlug: string; args: Record<string, unknown> }): string {
  const args = JSON.stringify(approval.args, null, 2);
  return `Approval required\n\nTool: ${approval.toolSlug}\nApproval: ${approval.id}\nArguments:\n${args}\n\nType /approve ${approval.id} or /deny ${approval.id}.`;
}
