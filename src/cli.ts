import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ChuskyClient, getCliConfigPath, loadCliConfig, saveCliConfig, type CliTask, type CliGeneratedFile } from "./cli/client.js";
import { formatApproval, formatError, formatSessionBanner, formatStatus, formatSuccess, formatToolSummary, formatWarning, paint, renderMarkdown } from "./cli/renderer.js";
import { pickModel } from "./cli/modelPicker.js";
import { approveFromPicker } from "./cli/approvalPicker.js";
import { readPrompt } from "./cli/input.js";
import { showPaged } from "./cli/pager.js";
import { runDoctor, runSetup } from "./cli/setup.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

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

function taskLine(task: CliTask, color: boolean): string {
  const statusColors: Record<CliTask["status"], "blue" | "green" | "yellow" | "red" | "cyan" | "dim"> = {
    queued: "blue", running: "cyan", blocked: "yellow", completed: "green", failed: "red", cancelled: "dim",
  };
  return `${paint(task.id, "dim", color)}  ${paint(`[${task.status}]`, statusColors[task.status], color)}  ${task.title}`;
}

function attachmentParts(line: string): { path: string; message: string } | undefined {
  const raw = line.slice("/attach".length).trim();
  if (!raw) return undefined;
  const quoted = raw.match(/^"([^"\r\n]+)"(?:\s+([\s\S]*))?$/);
  if (quoted) return { path: quoted[1], message: quoted[2]?.trim() ?? "" };
  const split = raw.search(/\s/);
  return split < 0 ? { path: raw, message: "" } : { path: raw.slice(0, split), message: raw.slice(split).trim() };
}

function mediaTypeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "video/webm", mp4: "video/mp4", pdf: "application/pdf", txt: "text/plain", md: "text/markdown" };
  return types[ext] ?? "application/octet-stream";
}

async function loadCollection(client: ChuskyClient, kind: "history" | "memories" | "scratchpad" | "reminders" | "jobs", query = ""): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await client.collection(kind, page, 50, query);
    if (!response.ok) throw new Error(response.error || `Could not load ${kind}.`);
    all.push(...(response.items ?? []));
    if (page >= response.totalPages) break;
  }
  return all;
}

async function saveArtifacts(images: { data: string; mediaType: string }[], files: CliGeneratedFile[] = [], color: boolean): Promise<void> {
  if (!images.length && !files.length) return;
  const directory = join(dirname(getCliConfigPath()), "artifacts");
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < images.length; i++) {
    const ext = images[i].mediaType.includes("jpeg") ? "jpg" : images[i].mediaType.includes("webp") ? "webp" : "png";
    const path = join(directory, `chusky-${Date.now()}-${i}.${ext}`);
    await writeFile(path, Buffer.from(images[i].data, "base64"));
    console.log(formatSuccess(`Saved artifact: ${path}`, color));
  }
  for (const file of files) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact.bin";
    const path = join(directory, `${Date.now()}-${safeName}`);
    await writeFile(path, Buffer.from(file.data, "base64"));
    console.log(formatSuccess(`Saved ${file.type || "file"} artifact: ${path}`, color));
  }
}

async function chat(): Promise<void> {
  const config = await loadCliConfig();
  const color = config.color ?? process.stdout.isTTY === true;
  if (!config.token) throw new Error("This terminal is not linked. Run: npm run cli -- auth link --server https://your-chusky-host");
  const client = new ChuskyClient(config);
  const promptHistory: string[] = [];
  const session = await client.session();
  if (!session.ok) throw new Error(session.error || "Could not load Chusky session");
  console.log(`\n${formatSessionBanner(session.model, session.userId, session.device, color)}`);
  if (session.approvals?.length) console.log(formatWarning(`Pending approvals: ${session.approvals.map((a) => a.id).join(", ")} (use /approvals to review)`, color));
  console.log(`${formatStatus("Ready", "Type /help for commands, paste multiline text directly, or /exit to leave.", color)}\n`);
  let activeAbort: AbortController | undefined;
  const notificationQueue: string[] = [];
  const eventsAbort = new AbortController();
  const eventWatcher = (async () => {
    try {
      for await (const events of client.eventStream(Date.now(), eventsAbort.signal)) {
        for (const task of events.tasks ?? []) notificationQueue.push(`${paint("Event", "magenta", color)} ${taskLine(task, color)}`);
        for (const approval of events.approvals ?? []) notificationQueue.push(formatWarning(`Approval required: ${approval.toolSlug} — /approve ${approval.id}`, color));
        for (const reminder of events.reminders ?? []) notificationQueue.push(`${paint("Reminder", "yellow", color)} ${reminder.text}`);
        for (const job of events.jobs ?? []) notificationQueue.push(`${paint("Job", "yellow", color)} ${job.text} (${job.cron})`);
      }
    } catch { /* a disconnected notification stream must never stop chat */ }
  })();
  const onSigint = () => { if (activeAbort) { activeAbort.abort(); console.log(`\n${formatWarning("Request cancelled. Returning to the prompt.", color)}`); } };
  process.on("SIGINT", onSigint);
  try {
    while (true) {
      const line = await readPrompt(paint("You> ", "green", color), promptHistory, () => notificationQueue.splice(0));
      if (line === null) break;
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") { console.log(`${paint("Commands", "cyan", color)}\n  /help /status /history /memory /scratchpad /reminders /jobs /tasks /approvals\n  /apps [page] /connect <toolkit> /tools search <query>\n  /triggers /trigger create|enable|disable|delete ...\n  /channel list|link <provider>|notify <provider> on|off\n  /voice [on|off|status] /usage /info /export /dashboard /image <description>\n  /task <id> /task retry <id> /task cancel <id>\n  /attach <path> [instruction] /devices /revoke <name>\n  /model [id] /approve <id> /deny <id> /clear history /clear session /exit\n\n${formatStatus("Input", "Paste multiline text and press Enter to send; Ctrl+J inserts a newline.", color)}\n${formatStatus("Approvals", "Use /approvals for ↑/↓ selection; Enter confirms; Esc cancels. Deny is the safe default.", color)}\n${formatStatus("Long lists", "Space/↓ next, b/↑ previous, q quit. Chat responses scroll normally.", color)}\n${formatStatus("Cancel", "Ctrl+C cancels only the active request; it does not close Chusky.", color)}\n`); continue; }
      if (line.startsWith("/approve ") || line.startsWith("/deny ")) {
        const [command, id] = line.split(/\s+/, 2);
        const result = await client.approve(id, command === "/approve" ? "approve" : "deny");
        console.log(result.ok ? (result.text ? renderMarkdown(result.text, color) : formatSuccess("Done.", color)) : formatError(result.error || "Request failed.", color));
        continue;
      }
      if (line === "/approvals") {
        const current = await client.session();
        if (!current.ok) { console.log(formatError(current.error || "Could not load approvals.", color)); continue; }
        if (!current.approvals?.length) { console.log(formatStatus("Approvals", "No pending approvals.", color)); continue; }
        const approval = current.approvals[0];
        const result = await approveFromPicker(client, approval, color);
        if (result) console.log(result.ok ? formatSuccess(`${approval.id}: ${result.text || "Decision recorded."}`, color) : formatError(result.error || "Approval could not be updated.", color));
        continue;
      }
      if (line === "/apps" || line.startsWith("/apps ")) {
        const page = Number(line.slice(5).trim()) || 1; const result = await client.apps(page);
        if (!result.ok) console.log(formatError(result.error || "Could not load apps.", color));
        else await showPaged(`${paint("App connections", "cyan", color)}  page ${result.page}/${result.totalPages}\n\n${result.apps?.map((app) => `${app.connected ? "✓" : "·"} ${app.name}  (${app.slug})`).join("\n") || "No apps found."}\n\nUse /apps ${result.page < result.totalPages ? result.page + 1 : 1} for another page.`, true);
        continue;
      }
      if (line.startsWith("/connect ")) {
        const toolkit = line.slice(9).trim(); const result = await client.connect(toolkit);
        console.log(result.ok ? `${formatSuccess(`Connection link for ${toolkit}:`, color)}\n${result.url}` : formatError(result.error || "Could not create connection link.", color)); continue;
      }
      if (line === "/info") {
        const result = await client.usage();
        console.log(result.ok ? `${paint("Chusky session", "cyan", color)}\n${formatStatus("User", String(result.userId), color)}\n${formatStatus("Model", String(result.model), color)}\n${formatStatus("Messages", String(result.totalMessages), color)}\n${formatStatus("Context", `${result.historyTurns}/${result.maxHistory} turns`, color)}\n${formatStatus("Tool rounds", String(result.maxToolRounds), color)}\n${formatStatus("Cost", `$${Number(result.totalCost || 0).toFixed(5)}`, color)}` : formatError(result.error || "Could not load session info.", color)); continue;
      }
      if (line === "/image" || line.startsWith("/image ")) {
        const prompt = line.slice(6).trim();
        if (!prompt) { console.log(formatError("Usage: /image <description>", color)); continue; }
        const result = await client.chat(`Generate an image of: ${prompt}`);
        if (!result.ok) console.log(formatError(result.error || "Image generation failed.", color));
        else { console.log(renderMarkdown(String(result.text || "Image generated."), color)); await saveArtifacts(Array.isArray(result.images) ? result.images as { data: string; mediaType: string }[] : [], Array.isArray(result.files) ? result.files as CliGeneratedFile[] : [], color); }
        continue;
      }
      if (line.startsWith("/tools")) {
        const query = line.replace(/^\/tools\s+search\s*/i, "").trim();
        if (!query) { console.log(formatError("Usage: /tools search <what you want to do>", color)); continue; }
        const result = await client.tools(query); if (result.ok) await showPaged((result.tools as any[] || []).map((tool: any) => `${tool.slug || tool.name || "tool"}\n${tool.description || ""}`).join("\n\n") || "No matching tools found.", true); else console.log(formatError(result.error || "Tool search failed.", color)); continue;
      }
      if (line === "/triggers") {
        const result = await client.triggers(); if (result.ok) await showPaged((result.triggers as any[] || []).map((t: any) => `${t.id || t.trigger_id} — ${t.trigger_slug || t.slug || "trigger"} — ${t.status || (t.enabled === false ? "disabled" : "active")}`).join("\n") || "No triggers found.", true); else console.log(formatError(result.error || "Could not load triggers.", color)); continue;
      }
      if (line.startsWith("/trigger ")) {
        const parts = line.slice(9).trim().split(/\s+/); const action = parts.shift() || ""; const value = parts.shift() || "";
        let config: Record<string, unknown> | undefined;
        if (action === "create" && parts.length) { try { config = JSON.parse(parts.join(" ")); } catch { console.log(formatError("Trigger configuration must be valid JSON.", color)); continue; } }
        if (!["create", "enable", "disable", "delete"].includes(action) || !value) { console.log(formatError("Usage: /trigger create <slug> <json> | /trigger enable|disable|delete <id>", color)); continue; }
        const result = await client.trigger(action as "create" | "enable" | "disable" | "delete", value, config); console.log(result.ok ? formatSuccess(`Trigger ${action} completed.`, color) : formatError(result.error || "Trigger operation failed.", color)); continue;
      }
      if (line === "/channel" || line.startsWith("/channel ")) {
        const parts = line.slice(8).trim().split(/\s+/); const action = parts.shift() || ""; const provider = parts.shift() || "";
        let result: any;
        if (action === "list") { result = await client.channels(); console.log(result.ok ? (result.channels?.map((c: any) => `${c.provider} — ${c.externalUserId}${c.workspaceId ? ` (${c.workspaceId})` : ""} — proactive ${c.proactiveOptIn === false ? "off" : "on"}`).join("\n") || "No external channels are linked.") : formatError(result.error || "Could not load channels.", color)); }
        else if (action === "link" && provider) { result = await client.channelLink(provider); console.log(result.ok ? `${formatSuccess(`Link code for ${provider}:`, color)} ${result.code}\n${result.instructions}` : formatError(result.error || "Could not create link code.", color)); }
        else if (action === "notify" && provider && (parts[0] === "on" || parts[0] === "off")) { result = await client.channelNotify(provider, parts[0] === "on"); console.log(result.ok ? formatSuccess(`Proactive ${provider} notifications are ${parts[0]}.`, color) : formatError(result.error || "Could not update notifications.", color)); }
        else console.log(formatError("Usage: /channel list | /channel link <provider> | /channel notify <provider> on|off", color));
        continue;
      }
      if (line === "/voice" || line.startsWith("/voice ")) {
        const action = line.slice(6).trim().toLowerCase(); const result = await client.voice(action === "on" || action === "enable" ? true : action === "off" || action === "disable" ? false : undefined);
        console.log(result.ok ? formatSuccess(result.enabled ? "Voice replies are on." : "Voice replies are off.", color) : formatError(result.error || "Could not update voice replies.", color)); continue;
      }
      if (line === "/usage") { const result = await client.usage(); console.log(result.ok ? `${formatStatus("Usage", `${result.totalMessages} messages  •  $${Number(result.totalCost || 0).toFixed(5)}`, color)}\n${formatStatus("Context", `${result.historyTurns}/${result.maxHistory} turns`, color)}\n${formatStatus("Voice", result.voiceReplies ? "on" : "off", color)}` : formatError(result.error || "Could not load usage.", color)); continue; }
      if (line === "/dashboard") { const result = await client.dashboard(); console.log(result.ok ? `${formatSuccess("Dashboard:", color)} ${result.url}` : formatError(result.error || "Dashboard is not configured.", color)); continue; }
      if (line === "/export") {
        const current = await client.session(); if (!current.ok) { console.log(formatError(current.error || "Could not load session.", color)); continue; }
        const path = join(process.cwd(), `chusky-export-${Date.now()}.txt`); const text = [`Chusky AI Agent`, `Model: ${current.model}`, `Exported: ${new Date().toISOString()}`, "─".repeat(50), "", ...(current.history || []).flatMap((m: any) => [`[${m.role === "user" ? "You" : "Chusky"}]`, m.content, ""])].join("\n");
        await writeFile(path, text, "utf8"); console.log(formatSuccess(`Conversation exported to ${path}`, color)); continue;
      }
      if (line === "/history") { const items = await loadCollection(client, "history"); await showPaged(items.map((m) => `${m.role}: ${m.content}`).join("\n") || "No history.", true); continue; }
      if (line === "/tasks") {
        const result = await client.tasks();
        if (!result.ok) console.log(formatError(result.error || "Could not load tasks.", color));
        else await showPaged(result.tasks?.length ? result.tasks.map((task) => taskLine(task, color)).join("\n") : "No durable tasks.", true);
        continue;
      }
      if (line.startsWith("/task ")) {
        const parts = line.split(/\s+/);
        const action = parts[1] === "retry" || parts[1] === "cancel" ? parts[1] : undefined;
        const id = action ? parts[2] : parts[1];
        if (!id || parts.length > (action ? 3 : 2)) { console.log(formatError("Usage: /task <id> | /task retry <id> | /task cancel <id>", color)); continue; }
        if (action) {
          const result = await client.taskAction(id, action);
          console.log(result.ok && result.task ? formatSuccess(`${action === "retry" ? "Retried" : "Cancelled"} ${taskLine(result.task, color)}`, color) : formatError(result.error || "Task action could not be applied.", color));
        } else {
          const result = await client.tasks();
          const task = result.tasks?.find((item) => item.id === id);
          if (!task) console.log(formatError(result.error || "Task not found.", color));
          else await showPaged(`${taskLine(task, color)}\n\nObjective: ${task.objective}\n${task.checkpoint ? `Checkpoint: ${task.checkpoint}\n` : ""}${task.nextAction ? `Next action: ${task.nextAction}\n` : ""}${task.error ? `Error: ${task.error}\n` : ""}\n${task.events?.map((event) => `${new Date(event.at).toISOString()}  ${event.type}: ${event.message}`).join("\n") || "No audit events."}`, true);
        }
        continue;
      }
      if (line === "/devices") {
        const result = await client.devices();
        if (!result.ok) console.log(formatError(result.error || "Could not load devices.", color));
        else console.log(result.devices?.length ? result.devices.map((device) => `${device.name}  •  last seen ${new Date(device.lastSeenAt).toLocaleString()}`).join("\n") : "No linked devices.");
        continue;
      }
      if (line.startsWith("/revoke ")) {
        const name = line.slice("/revoke ".length).trim().replace(/^"|"$/g, "");
        const result = await client.revokeDevice(name);
        console.log(result.ok ? formatSuccess(`Revoked ${name}.`, color) : formatError(result.error || "Device could not be revoked.", color));
        continue;
      }
      if (line.startsWith("/attach")) {
        const attachment = attachmentParts(line);
        if (!attachment) { console.log(formatError('Usage: /attach "path\\to\\file" [instruction]', color)); continue; }
        try {
          const bytes = await readFile(attachment.path);
          const result = await client.media(new Blob([bytes], { type: mediaTypeFor(attachment.path) }), attachment.path.split(/[\\/]/).pop() || "attachment", attachment.message);
          if (!result.ok) console.log(formatError(result.error || "Attachment failed.", color));
          else {
            console.log(`${paint("Chusky", "cyan", color)}\n${renderMarkdown(result.text || "", color)}\n${formatToolSummary((result.toolsUsed as string[] | undefined) || [], Number(result.cost ?? 0), color)}`);
            await saveArtifacts(Array.isArray(result.images) ? result.images as { data: string; mediaType: string }[] : [], [...(Array.isArray(result.files) ? result.files as CliGeneratedFile[] : []), ...(result.speech ? [{ ...result.speech as { data: string; mediaType: string }, name: "chusky.mp3", contentType: (result.speech as { data: string; mediaType: string }).mediaType, type: "voice" }] : [])], color);
          }
        } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); }
        continue;
      }
      if (["/status", "/memory", "/scratchpad", "/reminders", "/jobs"].includes(line) || line.startsWith("/memory ") || line.startsWith("/scratchpad ")) {
        if (line === "/status") {
          const current = await client.session();
          if (!current.ok) { console.log(formatError(current.error || "Could not load session.", color)); continue; }
          console.log(`${formatSessionBanner(current.model, current.userId, current.device, color)}\n${formatStatus("History", `${current.historyCount ?? current.history?.length ?? 0} messages`, color)}\n${formatStatus("Memory", `${current.memoryCount ?? 0} facts`, color)}\n${formatStatus("Scratchpad", `${current.scratchpadCount ?? 0} notes`, color)}\n${formatStatus("Approvals", `${current.approvals?.length ?? 0} pending`, color)}`);
        }
        if (line === "/memory" || line.startsWith("/memory ")) { const items = await loadCollection(client, "memories", line.slice("/memory".length).trim()); await showPaged(items.length ? items.map((m: any) => `[${m.category}] ${m.key}: ${m.value}`).join("\n") : "No matching memories.", true); }
        if (line === "/scratchpad" || line.startsWith("/scratchpad ")) { const items = await loadCollection(client, "scratchpad", line.slice("/scratchpad".length).trim()); await showPaged(items.length ? items.map((m: any) => `${m.key}: ${m.content}`).join("\n") : "Scratchpad is empty.", true); }
        if (line === "/reminders") { const items = await loadCollection(client, "reminders"); await showPaged(items.length ? items.map((r: any) => `${r.id} — ${new Date(r.runAt).toISOString()} — ${r.text}`).join("\n") : "No active reminders.", true); }
        if (line === "/jobs") { const items = await loadCollection(client, "jobs"); await showPaged(items.length ? items.map((j: any) => `${j.id} — ${j.cron} — ${j.text}`).join("\n") : "No active jobs.", true); }
        continue;
      }
      if (line.startsWith("/model")) {
        const model = line.slice("/model".length).trim();
        if (!model) {
          const current = (await client.session()).model;
          if (!process.stdin.isTTY || !process.stdout.isTTY) console.log(`Current model: ${current}`);
          else {
            const selected = await pickModel(client, current);
            if (selected) { const result = await client.model(selected); console.log(result.ok ? formatSuccess(`Selected ${selected}. History and session were kept.`, color) : formatError(result.error || "Could not change model.", color)); }
          }
        }
        else { const result = await client.model(model); console.log(result.ok ? formatSuccess(`Model changed to ${model}. History and session were kept.`, color) : formatError(result.error || "Could not change model.", color)); }
        continue;
      }
      if (line === "/clear history" || line === "/clear session") {
        const scope = line.endsWith("session") ? "session" : "history";
        const result = await client.clear(scope);
        console.log(result.ok ? formatSuccess(`${scope === "session" ? "Session and history" : "History"} cleared.`, color) : formatError(result.error || "Could not clear data.", color));
        continue;
      }
      if (line.startsWith("/")) {
        console.log(formatError(`Unknown command: ${line.split(/\s+/, 1)[0]}. Use /help to see available commands.`, color));
        continue;
      }
      const abort = new AbortController();
      activeAbort = abort;
      let final: any;
      let streamed = "";
      let streamedPrinted = 0;
      let pendingApproval: any;
      let streamedToTerminal = false;
      const startedAt = Date.now();
      process.stdout.write(`${formatStatus("Chusky", "Thinking…", color)}\n`);
      try {
        for await (const event of client.stream(line, abort.signal)) {
          if (event.type === "delta") {
            const delta = event.text ?? "";
            streamed += delta;
            if (delta) {
              if (!streamedToTerminal) { process.stdout.write(`\n${paint("Chusky ▸ ", "cyan", color)}`); streamedToTerminal = true; }
              // Do not render an incomplete Markdown link one delta at a time.
              // Otherwise `[label](url)` split across chunks is printed literally.
              const incomplete = streamed.match(/\[[^\]\n]*(?:\]\([^)]*)?$/);
              const safeLength = incomplete ? incomplete.index ?? streamed.length : streamed.length;
              if (safeLength > streamedPrinted) {
                process.stdout.write(renderMarkdown(streamed.slice(streamedPrinted, safeLength), color));
                streamedPrinted = safeLength;
              }
            }
          }
          else if (event.type === "start") process.stdout.write(`${formatStatus("Model", event.model || session.model, color)}\n`);
          else if (event.type === "approval_required" && event.approval) { pendingApproval = event.approval; }
          else if (event.type === "done") final = event;
          else if (event.type === "error") console.log(`\n${formatError(event.error || "Unknown Chusky error", color)}`);
        }
      } catch (error) { if (!abort.signal.aborted) console.log(`\n${formatError(error instanceof Error ? error.message : String(error), color)}`); }
      finally { activeAbort = undefined; }
      if (final) {
        const answer = renderMarkdown(String(final.text || streamed || ""), color);
        if (!streamedToTerminal) await showPaged(`\n${paint("Chusky", "cyan", color)}\n${answer}\n`, false);
        else { process.stdout.write(renderMarkdown(streamed.slice(streamedPrinted), color)); process.stdout.write("\n"); }
        console.log(`${formatToolSummary(final.toolsUsed || [], final.cost, color)}  ${paint(`${Date.now() - startedAt}ms`, "dim", color)}`);
        const images = Array.isArray(final.images) ? final.images as { data: string; mediaType: string }[] : [];
        await saveArtifacts(images, [...(Array.isArray(final.files) ? final.files as CliGeneratedFile[] : []), ...(final.speech ? [{ ...final.speech as { data: string; mediaType: string }, name: "chusky.mp3", contentType: final.speech.mediaType, type: "voice" }] : [])], color);
      }
      else if (pendingApproval) {
        const result = await approveFromPicker(client, pendingApproval, color);
        if (result) console.log(result.ok ? formatSuccess(`${pendingApproval.id}: ${result.text || "Decision recorded."}`, color) : formatError(result.error || "Approval could not be updated.", color));
        else console.log(`\n${formatApproval(pendingApproval, color)}\n`);
      }
    }
  } finally { eventsAbort.abort(); process.off("SIGINT", onSigint); await eventWatcher.catch(() => undefined); }
}

async function service(): Promise<void> {
  const built = join(__dirname, "index.js");
  const source = join(__dirname, "index.ts");
  const script = existsSync(built) ? built : source;
  const command = existsSync(built) ? process.execPath : (process.platform === "win32" ? "tsx.cmd" : "tsx");
  const child = spawn(command, [script], { stdio: "inherit", env: process.env });
  await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => { process.exitCode = code ?? 1; resolve(); }); });
}

async function devicesCommand(name?: string): Promise<void> {
  const config = await loadCliConfig();
  const color = config.color ?? process.stdout.isTTY === true;
  const client = new ChuskyClient(config);
  if (name) {
    const result = await client.revokeDevice(name);
    console.log(result.ok ? formatSuccess(`Revoked ${name}.`, color) : formatError(result.error || "Device could not be revoked.", color));
    return;
  }
  const result = await client.devices();
  if (!result.ok) throw new Error(result.error || "Could not load devices.");
  console.log(result.devices?.length ? result.devices.map((device) => `${device.name}  •  last seen ${new Date(device.lastSeenAt).toLocaleString()}`).join("\n") : "No linked devices.");
}

async function main(): Promise<void> {
  const command = process.argv[2] || "chat";
  if (command === "auth" && process.argv[3] === "link") await pair();
  else if (command === "setup") await runSetup();
  else if (command === "doctor" || command === "health") await runDoctor(arg("--server"));
  else if (command === "telegram" || command === "start") await service();
  else if (command === "chat") await chat();
  else if (command === "devices") await devicesCommand();
  else if (command === "revoke") await devicesCommand(process.argv.slice(3).join(" ").trim());
  else if (command === "help" || command === "--help" || command === "-h") console.log("chusky setup | doctor | chat | telegram | start | auth link");
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { console.error(`Chusky CLI: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
