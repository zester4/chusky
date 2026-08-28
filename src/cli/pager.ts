import { emitKeypressEvents } from "node:readline";

export async function showPaged(text: string): Promise<void> {
  const lines = text.split("\n");
  const pageSize = Math.max(5, (process.stdout.rows || 24) - 3);
  if (!process.stdin.isTTY || !process.stdout.isTTY || lines.length <= pageSize) { console.log(text); return; }
  return new Promise((resolve) => {
    let offset = 0;
    const stdin = process.stdin;
    const draw = () => {
      process.stdout.write("\u001b[2J\u001b[H");
      process.stdout.write(lines.slice(offset, offset + pageSize).join("\n"));
      process.stdout.write(`\n\n— lines ${offset + 1}-${Math.min(lines.length, offset + pageSize)} of ${lines.length} — Space/↓ next · b/↑ previous · q quit`);
    };
    const finish = () => { stdin.removeListener("keypress", onKeypress); stdin.setRawMode?.(false); stdin.pause(); process.stdout.write("\u001b[2J\u001b[H"); resolve(); };
    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c" || key.name === "q" || key.name === "escape") { finish(); return; }
      if (key.name === "down" || key.name === "space" || key.name === "n" || key.name === "return") { offset = Math.min(Math.max(0, lines.length - pageSize), offset + pageSize); draw(); return; }
      if (key.name === "up" || key.name === "b" || key.name === "p") { offset = Math.max(0, offset - pageSize); draw(); }
    };
    emitKeypressEvents(stdin); stdin.setRawMode?.(true); stdin.resume(); stdin.on("keypress", onKeypress); draw();
  });
}
