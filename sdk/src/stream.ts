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

export type SseRecord = { event: string; data: string; id?: string };

/** Parses Server-Sent Events so long-lived streams work in Node, browsers, workers, and edge runtimes. */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncIterable<SseRecord> {
  if (!body) throw new ChuskyError("Chusky returned an empty event stream");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  const dispatch = (): SseRecord | undefined => {
    if (!data.length) return undefined;
    const record = { event, data: data.join("\n"), ...(id ? { id } : {}) };
    event = "message";
    id = undefined;
    data = [];
    return record;
  };
  const consume = (line: string): SseRecord | undefined => {
    if (!line) return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
    return undefined;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const record = consume(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        if (record) yield record;
      }
      if (done) break;
    }
    if (pending) {
      const record = consume(pending.replace(/\r$/, ""));
      if (record) yield record;
    }
    const record = dispatch();
    if (record) yield record;
  } finally { reader.releaseLock(); }
}
