import { ChuskyError } from "./errors.js";

/** Parses NDJSON so a stream works in Node, browsers, workers, and edge runtimes. */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array> | null): AsyncIterable<T> {
  if (!body) throw new ChuskyError("Chusky returned an empty stream response");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
      }
      if (done) break;
    }
    const finalLine = pending.trim();
    if (finalLine) yield JSON.parse(finalLine) as T;
  } finally { reader.releaseLock(); }
}
