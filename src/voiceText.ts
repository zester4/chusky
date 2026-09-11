/** Convert model Markdown into natural text suitable for speech synthesis. */
export function normalizeVoiceText(input: string): string {
  let text = String(input ?? '').replace(/\r\n?/g, '\n');
  text = text
    .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, '$1: $2')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1: $2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replace(/[\*#]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}
