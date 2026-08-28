import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import { ChuskyClient, loadCliConfig, saveCliConfig } from "./cli/client.js";
import { formatApproval, renderMarkdown } from "./cli/renderer.js";
import { pickModel } from "./cli/modelPicker.js";
import { readPrompt } from "./cli/input.js";
import { showPaged } from "./cli/pager.js";
import { runDoctor, runSetup } from "./cli/setup.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function pair(): Promise<void> {
  const current = await loadCliConfig();
  const serverUrl = arg("--server") || current.serverUrl || (await prompt("Chusky server URL: ")).trim();
  const code = arg("--code") || (await prompt("Telegram pairing code: ")).trim();
  const deviceName = arg("--name") || `${process.env.COMPUTERNAME || process.env.HOSTNAME || "terminal"}`;
  const response = await new ChuskyClient({ serverUrl }).pair(code, deviceName);
  if (!response.ok || typeof response.token !== "string") throw new Error(response.error || "Pairing failed");
  await saveCliConfig({ serverUrl, token: response.token, deviceName });
  console.log(`Linked successfully as ${deviceName}. Configured durable Chusky session for user ${response.userId}.`);
}

async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try { return await rl.question(message); } finally { rl.close(); }
}

async function chat(): Promise<void> {
  const config = await loadCliConfig();
  if (!config.token) throw new Error("This terminal is not linked. Run: npm run cli -- auth link --server https://your-chusky-host");
  const client = new ChuskyClient(config);
  const promptHistory: string[] = [];
  const session = await client.session();
  if (!session.ok) throw new Error(session.error || "Could not load Chusky session");
  console.log(`Chusky — ${session.model} — shared session for user ${session.userId}`);
  if (session.approvals?.length) console.log(`Pending approvals: ${session.approvals.map((a) => a.id).join(", ")}`);
  console.log("Type /help for commands, paste multiline text directly, or /exit to leave.\n");
  const abort = new AbortController();
  const onSigint = () => { abort.abort(); console.log("\nRequest cancelled."); };
  process.on("SIGINT", onSigint);
  try {
    while (true) {
      const line = await readPrompt("You> ", promptHistory);
      if (line === null) break;
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") { console.log("/help /status /history /memory /scratchpad /reminders /jobs /model [id] /approve <id> /deny <id> /clear history /clear session /exit\nPaste multiline text and press Enter to send; Ctrl+J inserts a newline while typing. Long output opens a pager: Space/↓ next, b/↑ previous, q quit.\n"); continue; }
      if (line.startsWith("/approve ") || line.startsWith("/deny ")) {
        const [command, id] = line.split(/\s+/, 2);
        const result = await client.approve(id, command === "/approve" ? "approve" : "deny");
        console.log(result.ok ? (result.text ? renderMarkdown(result.text, config.color) : "Done.") : `Error: ${result.error}`);
        continue;
      }
      if (line === "/history") { const current = await client.session(); await showPaged(current.history?.map((m) => `${m.role}: ${m.content}`).join("\n") || "No history."); continue; }
      if (["/status", "/memory", "/scratchpad", "/reminders", "/jobs"].includes(line)) {
        const current = await client.session();
        if (!current.ok) { console.log(`Error: ${current.error}`); continue; }
        if (line === "/status") console.log(`User: ${current.userId}\nDevice: ${current.device}\nModel: ${current.model}\nHistory messages: ${current.history?.length ?? 0}\nPending approvals: ${current.approvals?.length ?? 0}`);
        if (line === "/memory") await showPaged(current.memories?.length ? current.memories.map((m: any) => `[${m.category}] ${m.key}: ${m.value}`).join("\n") : "No saved memories.");
        if (line === "/scratchpad") await showPaged(Object.keys(current.scratchpad ?? {}).length ? Object.entries(current.scratchpad ?? {}).map(([k, v]: [string, any]) => `${k}: ${v.content}`).join("\n") : "Scratchpad is empty.");
        if (line === "/reminders") await showPaged(current.reminders?.length ? current.reminders.map((r: any) => `${r.id} — ${new Date(r.runAt).toISOString()} — ${r.text}`).join("\n") : "No active reminders.");
        if (line === "/jobs") await showPaged(current.jobs?.length ? current.jobs.map((j: any) => `${j.id} — ${j.cron} — ${j.text}`).join("\n") : "No active jobs.");
        continue;
      }
      if (line.startsWith("/model")) {
        const model = line.slice("/model".length).trim();
        if (!model) {
          const current = (await client.session()).model;
          if (!process.stdin.isTTY || !process.stdout.isTTY) console.log(`Current model: ${current}`);
          else {
            const selected = await pickModel(client, current);
            if (selected) { const result = await client.model(selected); console.log(result.ok ? `Selected ${selected}. History and session were kept.` : `Error: ${result.error}`); }
          }
        }
        else { const result = await client.model(model); console.log(result.ok ? `Model changed to ${model}. History and session were kept.` : `Error: ${result.error}`); }
        continue;
      }
      if (line === "/clear history" || line === "/clear session") {
        const scope = line.endsWith("session") ? "session" : "history";
        const result = await client.clear(scope);
        console.log(result.ok ? `${scope === "session" ? "Session and history" : "History"} cleared.` : `Error: ${result.error}`);
        continue;
      }
      if (abort.signal.aborted) break;
      let final: any;
      let streamed = "";
      let pendingApproval: any;
      try {
        for await (const event of client.stream(line, abort.signal)) {
          if (event.type === "delta") streamed += event.text ?? "";
          else if (event.type === "approval_required" && event.approval) { pendingApproval = event.approval; }
          else if (event.type === "done") final = event;
          else if (event.type === "error") console.log(`\nError: ${event.error || "Unknown Chusky error"}`);
        }
      } catch (error) { console.log(`\nError: ${error instanceof Error ? error.message : String(error)}`); }
      if (final) {
        await showPaged(`\nChusky>\n${renderMarkdown(String(final.text || streamed || ""), config.color)}\n`);
        const images = Array.isArray(final.images) ? final.images as { data: string; mediaType: string }[] : [];
        for (let i = 0; i < images.length; i++) {
          const ext = images[i].mediaType.includes("jpeg") ? "jpg" : "png";
          const path = `chusky-${Date.now()}-${i}.${ext}`;
          await writeFile(path, Buffer.from(images[i].data, "base64"));
          console.log(`Saved generated image to ${path}`);
        }
      }
      else if (pendingApproval) console.log(`\n${formatApproval(pendingApproval)}\n`);
    }
  } finally { process.off("SIGINT", onSigint); }
}

async function service(): Promise<void> {
  const built = join(__dirname, "index.js");
  const source = join(__dirname, "index.ts");
  const script = existsSync(built) ? built : source;
  const command = existsSync(built) ? process.execPath : (process.platform === "win32" ? "tsx.cmd" : "tsx");
  const child = spawn(command, [script], { stdio: "inherit", env: process.env });
  await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => { process.exitCode = code ?? 1; resolve(); }); });
}

async function main(): Promise<void> {
  const command = process.argv[2] || "chat";
  if (command === "auth" && process.argv[3] === "link") await pair();
  else if (command === "setup") await runSetup();
  else if (command === "doctor" || command === "health") await runDoctor(arg("--server"));
  else if (command === "telegram" || command === "start") await service();
  else if (command === "chat") await chat();
  else if (command === "help" || command === "--help" || command === "-h") console.log("chusky setup | doctor | chat | telegram | start | auth link");
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { console.error(`Chusky CLI: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
