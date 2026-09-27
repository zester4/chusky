/** Convert agent CommonMark-style output to Slack's mrkdwn message syntax. */
export function formatSlackText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n").trim();
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${protectedParts.length}\u0000`;
    protectedParts.push(value);
    return token;
  };
  const escapeSlackText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Protect code first: its contents must not be interpreted as formatting or links.
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)\n```/g, (_match, _language: string, code: string) => protect(`\`\`\`\n${escapeSlackText(code)}\n\`\`\``));
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`\`${escapeSlackText(code)}\``));

  // Slack has no table primitive. A compact code block keeps columns and cell content readable.
  text = text.replace(/(?:^\|[^\n]*\|[ \t]*\n)+/gm, (table) => {
    const rows = table.trim().split("\n").map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
    if (rows.length < 2 || !rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))) return table;
    const contentRows = [rows[0], ...rows.slice(2)];
    const widths = rows[0].map((_, index) => Math.max(...contentRows.map((row) => (row[index] ?? "").length)));
    const rendered = contentRows.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd()).join("\n");
    return protect(`\`\`\`\n${escapeSlackText(rendered)}\n\`\`\``);
  });

  // Turn Markdown links into Slack links, allowing only web URLs as link targets.
  text = text.replace(/!?\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g, (_match, label: string, rawUrl: string) => {
    const url = rawUrl.startsWith("<") && rawUrl.endsWith(">") ? rawUrl.slice(1, -1) : rawUrl;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return escapeSlackText(label || url);
      const safeUrl = parsed.toString().replace(/\|/g, "%7C").replace(/>/g, "%3E");
      return protect(`<${safeUrl}|${escapeSlackText(label || url)}>`);
    } catch {
      return escapeSlackText(label || url);
    }
  });

  // Map block and inline Markdown constructs to Slack's mrkdwn spellings.
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, value: string) => protect(`*${value}*`))
    .replace(/__([^_\n]+)__/g, (_match, value: string) => protect(`*${value}*`))
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\*)/g, "_$1_")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "_$1_")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1. ")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, () => protect("> "))
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "────────")
    .replace(/\n{3,}/g, "\n\n");

  // Slack has no heading syntax; render headings in bold after inline emphasis is handled.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_match, heading: string) => protect(`*${escapeSlackText(heading.trim())}*`));

  // Escape ordinary text while retaining only Slack control sequences produced above.
  text = text.replace(/&(?!amp;|lt;|gt;|#\d+;|#x[\da-f]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedParts[Number(index)] ?? "").trim();
}
