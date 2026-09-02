import { emitKeypressEvents } from "node:readline";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { StringDecoder } from "node:string_decoder";

const COMMANDS = [
  "/help", "/status", "/history", "/memory", "/scratchpad", "/reminders", "/jobs", "/tasks", "/task",
  "/apps", "/connect", "/tools", "/triggers", "/trigger", "/channel", "/voice", "/call", "/usage", "/export", "/dashboard",
  "/attach", "/devices", "/revoke", "/model", "/approve", "/deny", "/clear history", "/clear session", "/exit",
];

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
function width(): number { return Math.max(20, process.stdout.columns || 80); }
function lines(prompt: string, value: string): string[] {
  const out: string[] = [];
  for (const logical of `${prompt}${value}`.split("\n")) {
    if (!logical) { out.push(""); continue; }
    for (let i = 0; i < logical.length; i += width()) out.push(logical.slice(i, i + width()));
  }
  return out.length ? out : [""];
}

/** Terminal-safe multiline editor with bracketed-paste preservation. */
export async function readPrompt(prompt: string, history: string[], onNotification?: () => string[]): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let raw = ""; for await (const chunk of process.stdin) raw += String(chunk);
    const value = raw.replace(/\r\n/g, "\n").replace(/\n$/, ""); if (value.trim()) history.push(value); return value;
  }
  emitKeypressEvents(process.stdin);
  const stdin = process.stdin, stdout = process.stdout, decoder = new StringDecoder("utf8");
  const entries = [...history].slice(-100); let value = "", cursor = 0, historyIndex = entries.length, draft = "";
  let rendered = 0, drawnCursorRow = 0, paste = false, settled = false; let resolve!: (value: string | null) => void;
  const redraw = () => {
    if (drawnCursorRow > 0) moveCursor(stdout, 0, -drawnCursorRow);
    cursorTo(stdout, 0); clearScreenDown(stdout); stdout.write(`${prompt}${value}`);
    rendered = lines(prompt, value).length;
    const before = `${prompt}${value.slice(0, cursor)}`; const parts = before.split("\n");
    const row = lines(prompt, before).length - 1; const col = parts.at(-1)!.length % width();
    if (row < rendered - 1) moveCursor(stdout, 0, -(rendered - 1 - row)); cursorTo(stdout, col); drawnCursorRow = row;
  };
  const finish = (answer: string | null) => { if (settled) return; settled = true; if (answer !== null) stdout.write("\n"); resolve(answer); };
  const insert = (text: string) => { value = value.slice(0, cursor) + text + value.slice(cursor); cursor += text.length; };
  const complete = () => { if (value.includes("\n")) return; const hits = COMMANDS.filter((c) => c.startsWith(value)); if (hits.length === 1) insert(`${hits[0].slice(value.length)} `); else if (hits.length > 1) { stdout.write(`\n${hits.join("  ")}\n`); rendered = 0; redraw(); } };
  const onData = (chunk: Buffer) => {
    if (settled) return;
    let data = decoder.write(chunk);
    while (data) {
      if (paste) { const end = data.indexOf(PASTE_END); if (end < 0) { insert(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n")); break; } insert(data.slice(0, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n")); paste = false; data = data.slice(end + PASTE_END.length); continue; }
      if (data.startsWith(PASTE_START)) { paste = true; data = data.slice(PASTE_START.length); continue; }
      if (data.startsWith("\u001b[A")) { historyIndex = Math.max(0, historyIndex - 1); if (historyIndex === entries.length - 1) draft = value; value = entries[historyIndex] ?? ""; cursor = value.length; data = data.slice(3); continue; }
      if (data.startsWith("\u001b[B")) { historyIndex = Math.min(entries.length, historyIndex + 1); value = historyIndex === entries.length ? draft : entries[historyIndex] ?? ""; cursor = value.length; data = data.slice(3); continue; }
      if (data.startsWith("\u001b[D")) { cursor = Math.max(0, cursor - 1); data = data.slice(3); continue; }
      if (data.startsWith("\u001b[C")) { cursor = Math.min(value.length, cursor + 1); data = data.slice(3); continue; }
      const code = data.charCodeAt(0);
      if (code === 3) { value = ""; cursor = 0; finish(""); data = data.slice(1); continue; }
      if (code === 4) { if (!value) finish(null); else value = value.slice(0, cursor) + value.slice(cursor + 1); data = data.slice(1); continue; }
      if (code === 9) { complete(); data = data.slice(1); continue; }
      if (code === 13) { if (value.trim()) { history.push(value); if (history.length > 100) history.splice(0, history.length - 100); finish(value); } data = data.slice(1); continue; }
      if (code === 10) { insert("\n"); data = data.slice(1); continue; }
      if (code === 8 || code === 127) { if (cursor) { value = value.slice(0, cursor - 1) + value.slice(cursor); cursor--; } data = data.slice(1); continue; }
      if (code === 27) { data = data.slice(1); continue; }
      insert(data[0]); data = data.slice(1);
    }
    if (!settled) redraw();
  };
  const notificationTimer = onNotification ? setInterval(() => { const notifications = onNotification(); if (!notifications.length || settled) return; if (drawnCursorRow > 0) moveCursor(stdout, 0, -drawnCursorRow); cursorTo(stdout, 0); clearScreenDown(stdout); stdout.write(`${notifications.join("\n")}\n`); rendered = 0; drawnCursorRow = 0; redraw(); }, 250) : undefined;
  stdout.write("\u001b[?2004h");
  stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData); stdout.write(prompt); rendered = 1;
  const answer = await new Promise<string | null>((done) => { resolve = done; });
  if (notificationTimer) clearInterval(notificationTimer); stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); stdout.write("\u001b[?2004l"); return answer;
}
