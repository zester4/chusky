import type { CliModel, ChuskyClient } from "./client.js";
import { clearScreenDown, emitKeypressEvents, moveCursor } from "node:readline";
import { paint } from "./renderer.js";

function label(model: CliModel, current: string, selected: boolean, number: number): string {
  const marker = selected ? "❯" : " ";
  const shortcut = number === 10 ? "0" : String(number);
  const currentLabel = model.id === current ? "  (current)" : "";
  const row = `${shortcut} ${model.name || model.id}  (${model.id})${currentLabel}`;
  return selected ? `${paint(marker, "cyan")} ${paint(row, "white")}` : `  ${row}`;
}

export async function pickModel(client: ChuskyClient, current: string, pageSize = 10): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  let page = 1;
  let index = 0;
  let models: CliModel[] = [];
  let totalPages = 1;
  let loading = false;
  let renderedLines = 0;

  const load = async () => {
    loading = true;
    const result = await client.models(page, pageSize);
    if (!result.ok) throw new Error(result.error || "Could not load models");
    models = result.models;
    totalPages = result.totalPages;
    index = Math.min(index, Math.max(0, models.length - 1));
    loading = false;
  };
  await load();

  return await new Promise<string | undefined>((resolve, reject) => {
    const stdin = process.stdin;
    const finish = (value?: string) => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode?.(false);
      stdin.pause();
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        clearScreenDown(process.stdout);
      }
      process.stdout.write("\n");
      resolve(value);
    };
    const draw = () => {
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        clearScreenDown(process.stdout);
      }
      const lines = [
        `${paint("Chusky model picker", "cyan")}  •  page ${page}/${totalPages}`,
        "↑/↓ or Tab move   Space/Enter select   1-9/0 quick select   n/p page   Esc cancel",
        "",
      ];
      if (loading) lines.push(paint("Loading…", "dim"));
      else {
        for (let i = 0; i < models.length; i++) lines.push(label(models[i], current, i === index, i + 1));
        lines.push("", `${models.length} models shown. Enter selects the highlighted row.`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const changePage = async (next: number) => {
      if (next < 1 || next > totalPages || loading) return;
      page = next;
      try { await load(); draw(); } catch (error) { finish(); reject(error); }
    };
    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") { finish(); return; }
      if (key.name === "escape" || key.name === "q") { finish(); return; }
      if (key.name === "up") { index = Math.max(0, index - 1); draw(); return; }
      if (key.name === "down" || key.name === "tab") { index = (index + 1) % Math.max(1, models.length); draw(); return; }
      if (key.name === "n") { void changePage(page + 1); return; }
      if (key.name === "p") { void changePage(page - 1); return; }
      if (key.name === "space" || key.sequence === " " || key.name === "return" || key.sequence === "\r" || key.sequence === "\n") { finish(models[index]?.id); return; }
      if (key.name && /^[0-9]$/.test(key.name)) {
        const quickIndex = key.name === "0" ? 9 : Number(key.name) - 1;
        if (models[quickIndex]) { index = quickIndex; draw(); }
      }
    };
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    draw();
  });
}
