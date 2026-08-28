import { emitKeypressEvents } from "node:readline";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function redraw(prompt: string, value: string, previousLines: number): number {
  const width = Math.max(20, (process.stdout.columns || 80) - prompt.length - 1);
  const logical = value.split("\n");
  const lines: string[] = [];
  logical.forEach((line, i) => {
    const prefix = i === 0 ? prompt : "… ";
    if (!line) lines.push(prefix);
    else for (let start = 0; start < line.length; start += width) lines.push(prefix + line.slice(start, start + width));
  });
  if (!lines.length) lines.push(prompt);
  if (previousLines > 0) process.stdout.write(`\u001b[${previousLines}A`);
  for (let i = 0; i < Math.max(previousLines, lines.length); i++) process.stdout.write(`\r\u001b[2K${lines[i] ?? ""}${i < Math.max(previousLines, lines.length) - 1 ? "\n" : ""}`);
  return lines.length;
}

export async function readPrompt(prompt: string, history: string[]): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    let historyIndex = history.length;
    let previousLines = 0;
    let rawBuffer = "";
    let inPaste = false;
    const finish = (result: string | null) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      process.stdout.write("\u001b[?2004l\n");
      resolve(result);
    };
    const show = () => { previousLines = redraw(prompt, value, previousLines); };
    const accept = () => {
      const result = value.trim();
      if (result) history.push(result);
      finish(result);
    };
    const onData = (chunk: Buffer) => {
      rawBuffer += chunk.toString("utf8");
      while (rawBuffer) {
        if (inPaste) {
          const end = rawBuffer.indexOf(PASTE_END);
          if (end < 0) { value += rawBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); rawBuffer = ""; show(); return; }
          value += rawBuffer.slice(0, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n"); rawBuffer = rawBuffer.slice(end + PASTE_END.length); inPaste = false; show(); continue;
        }
        if (rawBuffer.startsWith(PASTE_START)) { inPaste = true; rawBuffer = rawBuffer.slice(PASTE_START.length); continue; }
        if (rawBuffer.startsWith("\u001b[A")) { if (historyIndex > 0) value = history[--historyIndex] ?? ""; rawBuffer = rawBuffer.slice(3); show(); continue; }
        if (rawBuffer.startsWith("\u001b[B")) { if (historyIndex < history.length - 1) value = history[++historyIndex] ?? ""; else { historyIndex = history.length; value = ""; } rawBuffer = rawBuffer.slice(3); show(); continue; }
        if (rawBuffer.startsWith("\u001b")) { rawBuffer = rawBuffer.slice(rawBuffer.length > 1 ? 2 : 1); continue; }
        const code = rawBuffer.charCodeAt(0); const char = rawBuffer[0]; rawBuffer = rawBuffer.slice(1);
        if (code === 3) { finish(null); return; }
        if (code === 4) { if (!value) { finish(null); return; } continue; }
        if (code === 21) { value = ""; show(); continue; }
        if (code === 10) { value += "\n"; show(); continue; }
        if (code === 13) { accept(); return; }
        if (code === 8 || code === 127) { value = value.slice(0, -1); show(); continue; }
        if (code >= 32 || char === "\t") { value += char; show(); }
      }
    };
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    process.stdout.write("\u001b[?2004h");
    stdin.resume();
    stdin.on("data", onData);
    show();
  });
}
