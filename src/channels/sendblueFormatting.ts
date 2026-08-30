/**
 * Convert the Markdown produced by the agent into readable iMessage text.
 * Sendblue delivers `content` as plain text; iMessage does not render Markdown.
 */
export function formatSendblueText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n").trim();

  text = text
    .replace(/^\s*```[^\n]*\n([\s\S]*?)\n\s*```\s*$/gm, "$1")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, "$1: $2")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1: $2")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, (_, heading: string) => heading.toUpperCase())
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]*>[ \t]?/gm, "│ ")
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "────────")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
