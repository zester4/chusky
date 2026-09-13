/** Convert model Markdown into natural text suitable for speech synthesis. */
export function normalizeVoiceText(input: string): string {
  let text = String(input ?? '').replace(/\r\n?/g, '\n');
  text = text
    .replace(/```(?:[^\n]*)\n?[\s\S]*?```/g, ' I can share the technical details in writing. ')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1')
    .replace(/https?:\/\/[^\s)]+/gi, ' link ')
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
    // Prices should be spoken as money rather than a character sequence.
    .replace(/\$(\d{1,7})(?:\.(\d{1,2}))?/g, (_match, dollars: string, cents?: string) => {
      const whole = Number(dollars);
      const parts = [`${whole} dollar${whole === 1 ? '' : 's'}`];
      if (cents !== undefined) {
        const value = Number(cents.padEnd(2, '0'));
        if (value) parts.push(`and ${value} cent${value === 1 ? '' : 's'}`);
      }
      return parts.join(' ');
    })
    // Repair malformed streamed boundaries defensively. Normal streams retain
    // their whitespace through normalizeVoiceDelta below.
    .replace(/([.!?;:])(?=[A-Za-z])/g, '$1 ')
    .replace(/([a-z])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[A-Za-z])/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/**
 * Prepare one streamed model delta without changing its leading/trailing
 * whitespace. Calling the final speech formatter on individual deltas glues
 * words together and makes TTS spell fragments character-by-character.
 */
export function normalizeVoiceDelta(input: string): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
