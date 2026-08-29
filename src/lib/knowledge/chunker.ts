export interface TextChunk { id: string; text: string; chunkIndex: number; start: number; end: number; }

/** Deterministic, UTF-16-safe chunking for extracted document text. */
export function chunkText(text: string, options: { maxCharacters?: number; overlapCharacters?: number } = {}): TextChunk[] {
  const max = options.maxCharacters ?? 6000;
  const overlap = Math.min(options.overlapCharacters ?? 500, Math.floor(max / 2));
  if (!Number.isInteger(max) || max < 100) throw new Error("maxCharacters must be at least 100");
  if (!Number.isInteger(overlap) || overlap < 0) throw new Error("overlapCharacters must be non-negative");
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + max, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n\n", end);
      if (boundary > start + Math.floor(max * 0.55)) end = boundary;
      else { const space = normalized.lastIndexOf(" ", end); if (space > start + Math.floor(max * 0.75)) end = space; }
    }
    const value = normalized.slice(start, end).trim();
    if (value) chunks.push({ id: `chunk_${chunks.length}`, text: value, chunkIndex: chunks.length, start, end });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
