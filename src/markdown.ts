/**
 * Converts LLM Markdown → Telegram HTML (parse_mode: "HTML")
 *
 * Telegram Bot API supported tags (as of 2026):
 *   <b>, <strong>                bold
 *   <i>, <em>                   italic
 *   <u>, <ins>                  underline
 *   <s>, <strike>, <del>        strikethrough
 *   <code>                      inline monospace
 *   <pre>                       preformatted block
 *   <pre><code class="language-LANG">  code block with syntax hint
 *   <a href="URL">              hyperlink (URL must be http/https/tg)
 *   <blockquote>                block quote
 *   <blockquote expandable>     collapsible block quote
 *   <span class="tg-spoiler">  spoiler
 *   <tg-emoji emoji-id="...">  custom emoji (ignored if unsupported)
 *
 * Supported named HTML entities: &lt; &gt; &amp; &quot;
 * ALL other & must be &amp; — no numeric entities.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mdToTelegramHtml(text: string): string {
  // ── 1. Extract fenced code blocks ──────────────────────────────────
  const codeBlocks: string[] = [];
  let out = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const esc = escapeHtml(code.replace(/^\n/, "").replace(/\n$/, ""));
    const tag = lang
      ? `<pre><code class="language-${lang}">${esc}</code></pre>`
      : `<pre><code>${esc}</code></pre>`;
    codeBlocks.push(tag);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // ── 2. Extract inline code ──────────────────────────────────────────
  const inlineCodes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // ── 3. Escape HTML in remaining plain text ──────────────────────────
  out = escapeHtml(out);

  // ── 4. Block-level ──────────────────────────────────────────────────

  // ATX headings → bold
  out = out.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");

  // Blockquotes — collapse consecutive > lines into one <blockquote>
  out = out.replace(/((?:^&gt;[^\n]*\n?)+)/gm, (block) => {
    const inner = block
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^&gt;\s?/, ""))
      .join("\n");
    return `<blockquote>${inner}</blockquote>`;
  });

  // Horizontal rules
  out = out.replace(/^[-*_]{3,}$/gm, "──────────────────");

  // Unordered lists
  out = out.replace(/^[ \t]*[-*+][ \t]+(.+)$/gm, "• $1");

  // Ordered lists
  out = out.replace(/^[ \t]*\d+\.[ \t]+(.+)$/gm, "→ $1");

  // ── 5. Inline formatting ────────────────────────────────────────────

  // Bold **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
  out = out.replace(/(?<![_\w])__(?!_)(.+?)(?<!_)__(?![_\w])/gs, "<b>$1</b>");

  // Italic *text* (single star) — don't match **
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<i>$1</i>");
  // Italic _text_ (single underscore) — don't match __
  out = out.replace(/(?<![_\w])_(?!_)(.+?)(?<!_)_(?![_\w])/gs, "<i>$1</i>");

  // Strikethrough ~~text~~
  out = out.replace(/~~(.+?)~~/gs, "<s>$1</s>");

  // Spoiler ||text|| (Discord-style, often produced by LLMs)
  out = out.replace(/\|\|(.+?)\|\|/gs, '<span class="tg-spoiler">$1</span>');

  // Underline ++text++ (less common but some LLMs use it)
  out = out.replace(/\+\+(.+?)\+\+/gs, "<u>$1</u>");

  // Hyperlinks [text](url)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // ── 6. Restore placeholders ─────────────────────────────────────────
  out = out.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[+i]);
  out = out.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[+i]);

  // ── 7. Clean up excess whitespace ───────────────────────────────────
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Split a long HTML string into Telegram-safe chunks (≤ 4096 chars).
 * Tries to split on double newlines to avoid cutting mid-sentence.
 */
export function splitHtml(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let buf = "";

  for (const para of text.split(/\n\n/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length > maxLen) {
      if (buf) chunks.push(buf.trim());
      // If a single para exceeds the limit, hard-split it
      if (para.length > maxLen) {
        for (let i = 0; i < para.length; i += maxLen) {
          chunks.push(para.slice(i, i + maxLen));
        }
        buf = "";
      } else {
        buf = para;
      }
    } else {
      buf = candidate;
    }
  }

  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
