/**
 * Convert Chusky Markdown into the limited formatting WhatsApp renders.
 * WhatsApp text messages do not support Markdown or HTML directly.
 */
export function formatWhatsAppText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n").trim();
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${protectedParts.length}\u0000`;
    protectedParts.push(value);
    return token;
  };

  // Preserve code blocks before processing emphasis markers.
  text = text.replace(/```(?:[^\n]*)\n([\s\S]*?)\n```/g, (_, code: string) => protect(`\`\`\`${code}\`\`\``));
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => protect(`\`\`\`${code}\`\`\``));

  // WhatsApp auto-links bare URLs, so retain the URL next to its label.
  text = text
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, "$1: $2")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1: $2");

  const bold = (value: string) => protect(`*${value}*`);
  text = text
    .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, (_, heading: string) => bold(heading.trim()))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, value: string) => bold(value))
    .replace(/__([^_\n]+)__/g, (_, value: string) => bold(value))
    .replace(/~~([^~\n]+)~~/g, (_, value: string) => protect(`~${value}~`))
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, value: string) => protect(`_${value}_`))
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, (_, value: string) => protect(`_${value}_`))
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]*>[ \t]?/gm, "│ ")
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "────────")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => protectedParts[Number(index)] ?? "");
}
