import { clearScreenDown, emitKeypressEvents, moveCursor } from "node:readline";
import type { ChuskyClient, CliResponse } from "./client.js";
import { paint } from "./renderer.js";

export interface CliApproval { id: string; toolSlug: string; args: Record<string, unknown>; }

/** A keyboard-first approval prompt. Deny is selected initially for safety. */
export async function pickApproval(approval: CliApproval, color = true): Promise<"approve" | "deny" | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const stdin = process.stdin;
  let index = 1;
  let rendered = 0;
  return new Promise((resolve) => {
    const finish = (decision?: "approve" | "deny") => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      stdin.pause();
      if (rendered) { moveCursor(process.stdout, 0, -rendered); clearScreenDown(process.stdout); }
      process.stdout.write("\n");
      resolve(decision);
    };
    const draw = () => {
      if (rendered) { moveCursor(process.stdout, 0, -rendered); clearScreenDown(process.stdout); }
      const args = JSON.stringify(approval.args, null, 2);
      const rows = [
        paint("Approval required", "yellow", color),
        "",
        `${paint("Tool:", "magenta", color)} ${approval.toolSlug}`,
        `${paint("Approval:", "magenta", color)} ${approval.id}`,
        `${paint("Arguments:", "magenta", color)}`,
        args,
        "",
        `${index === 0 ? "❯" : " "} ${paint("Approve", index === 0 ? "green" : "white", color)}`,
        `${index === 1 ? "❯" : " "} ${paint("Deny", index === 1 ? "red" : "white", color)}`,
        "",
        "↑/↓ or Tab navigate   Enter select   Esc cancel (defaults to Deny)",
      ];
      process.stdout.write(`${rows.join("\n")}\n`); rendered = rows.length;
    };
    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") { finish(); return; }
      if (key.name === "escape" || key.name === "q") { finish(); return; }
      if (key.name === "up" || key.name === "down" || key.name === "tab") { index = index === 0 ? 1 : 0; draw(); return; }
      if (key.name === "return" || key.name === "space" || key.sequence === "\r" || key.sequence === "\n") { finish(index === 0 ? "approve" : "deny"); }
    };
    emitKeypressEvents(stdin); stdin.setRawMode?.(true); stdin.resume(); stdin.on("keypress", onKeypress); draw();
  });
}

export async function approveFromPicker(client: ChuskyClient, approval: CliApproval, color: boolean): Promise<CliResponse | undefined> {
  const decision = await pickApproval(approval, color);
  if (!decision) return undefined;
  return client.approve(approval.id, decision);
}
