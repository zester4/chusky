import type { CliModel, ChuskyClient } from "./client.js";
import { emitKeypressEvents } from "node:readline";

const ESC = "\u001b[";

function clearScreen(): void { process.stdout.write(`${ESC}2J${ESC}H`); }
function label(model: CliModel, current: string): string {
  const marker = model.id === current ? "*" : " ";
  return `${marker} ${model.name || model.id}  (${model.id})`;
}

export async function pickModel(client: ChuskyClient, current: string, pageSize = 10): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  let page = 1;
  let index = 0;
  let models: CliModel[] = [];
  let totalPages = 1;
  let loading = false;

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
      clearScreen();
      resolve(value);
    };
    const draw = () => {
      clearScreen();
      console.log(`Chusky model picker  •  page ${page}/${totalPages}`);
      console.log("↑/↓/Tab navigate   Space/Enter select   n/p page   Esc cancel\n");
      if (loading) { console.log("Loading…"); return; }
      for (let i = 0; i < models.length; i++) console.log(`${i === index ? "❯" : " "} ${label(models[i], current)}`);
      console.log(`\n${models.length} models shown. Use /model <id> to select directly.`);
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
      if (key.name === "space" || key.name === "return") { finish(models[index]?.id); }
    };
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    draw();
  });
}
