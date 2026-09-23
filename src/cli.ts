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

function autonomyLine(item: any, color: boolean): string {
  const state = item.blockedReason ? "blocked" : item.status;
  const tone = state === "blocked" ? "yellow" : state === "completed" ? "green" : "cyan";
  return `${paint(String(item.id), "dim", color)}  ${paint(`[${state}]`, tone as "yellow" | "green" | "cyan", color)}  ${item.title}${item.nextAction ? ` — ${item.nextAction}` : ""}`;
}

function missionLine(mission: any, color: boolean): string {
  const statusColor = mission.status === "completed" ? "green" : ["failed", "cancelled"].includes(mission.status) ? "red" : ["paused", "blocked", "waiting"].includes(mission.status) ? "yellow" : "cyan";
  const active = Array.isArray(mission.activeStepIds) && mission.activeStepIds.length ? ` · ${mission.activeStepIds.length} active step${mission.activeStepIds.length === 1 ? "" : "s"}` : "";
  return `${paint(String(mission.id), "dim", color)}  ${paint(`[${mission.status}]`, statusColor as "green" | "red" | "yellow" | "cyan", color)}  ${mission.title}${active}`;
}

function missionDetail(mission: any, color: boolean): string {
  const lines = [missionLine(mission, color), `Objective: ${mission.objective}`, `Definition of done: ${mission.definitionOfDone}`, `Next action: ${mission.nextAction || "not set"}`, `Checkpoint: ${mission.checkpoint || "none"}`, `Budget: ${mission.consumedSteps}/${mission.budget?.maxSteps ?? "?"} steps · ${mission.toolCalls}/${mission.budget?.maxToolCalls ?? "?"} tools · $${Number(mission.cost || 0).toFixed(4)}/${mission.budget?.maxCost ?? "?"}`];
  if (mission.waiting) lines.push(`Waiting: ${JSON.stringify(mission.waiting)}`);
  if (Array.isArray(mission.steps)) lines.push(`\nSteps:\n${mission.steps.map((step: any) => `- ${step.id} [${step.status}] ${step.title}${step.dependsOn?.length ? ` (after ${step.dependsOn.join(", ")})` : ""}${step.result ? `\n  ${step.result}` : ""}`).join("\n")}`);
  if (mission.verification) lines.push(`\nVerification: ${mission.verification.verified ? "verified" : "not verified"}${mission.verification.unresolved?.length ? ` — ${mission.verification.unresolved.join("; ")}` : ""}`);
  if (mission.error) lines.push(`Error: ${mission.error}`);
  return lines.join("\n");
}

function parseJson<T>(value: string, usage: string): T {
  try { return JSON.parse(value) as T; } catch { throw new Error(`Invalid JSON. Usage: ${usage}`); }
}

function meetingLine(meeting: any, color: boolean): string {
  const participants = Array.isArray(meeting.participantRoster) ? meeting.participantRoster.filter((person: any) => person.status !== "left").map((person: any) => person.name).filter(Boolean).slice(0, 8).join(", ") : "";
  return `${paint(meeting.id, "dim", color)}  ${paint(`[${meeting.status}]`, meeting.status === "in_call" ? "green" : meeting.status === "failed" ? "red" : "cyan", color)}  ${meeting.platform}  ${meeting.title || "Untitled meeting"}${participants ? `\n  Participants: ${participants}` : ""}`;
}

function meetingDetail(meeting: any, contacts: any[] = [], color: boolean): string {
  const lines = [meetingLine(meeting, color), `Mode: ${meeting.interactionMode}`, `Searchable transcript: ${meeting.searchableTranscript ? "yes" : "no"}`];
  if (meeting.mission) lines.push(`Mission: ${meeting.mission.clientName} — ${meeting.mission.objective}`);
  if (meeting.participantRoster?.length) lines.push(`\nParticipants:\n${meeting.participantRoster.map((person: any) => `- ${person.name}${person.isHost ? " (host)" : ""} — ${person.status}`).join("\n")}`);
  if (contacts.length) lines.push(`\nCaptured contacts:\n${contacts.map((contact: any) => `- ${contact.participantName}: ${contact.email || contact.phone || "no contact"}${contact.interest ? ` — ${contact.interest}` : ""}`).join("\n")}`);
  if (meeting.outcome) lines.push(`\nOutcome:\n${JSON.stringify(meeting.outcome, null, 2)}`);
  if (meeting.history?.length) lines.push(`\nRecent meeting conversation:\n${meeting.history.map((message: any) => `${message.role === "assistant" ? "Chusky" : "Meeting"}: ${message.content}`).join("\n")}`);
  return lines.join("\n");
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
  const types: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "video/webm", mp4: "video/mp4", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip", txt: "text/plain", md: "text/markdown" };
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

async function saveDownloadedArtifact(client: ChuskyClient, id: string, color: boolean): Promise<void> {
  const artifact = await client.downloadArtifact(id);
  const directory = join(dirname(getCliConfigPath()), "artifacts");
  await mkdir(directory, { recursive: true });
  const safeName = artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || `${id}.bin`;
  const path = join(directory, `${Date.now()}-${safeName}`);
  await writeFile(path, artifact.data);
  console.log(formatSuccess(`Downloaded artifact to ${path}`, color));
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
        for (const run of events.runs ?? []) notificationQueue.push(`${paint("Run", "magenta", color)} ${run.id} [${run.status}] ${run.input.slice(0, 120)}`);
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
      if (line === "/help") { console.log(`${paint("Commands", "cyan", color)}\n  /help /status /history /memory /scratchpad /reminders /jobs /tasks /approvals\n  /reminders|/jobs pause|resume|run|cancel <id>\n  /missions [id] /mission create|pause|resume|cancel|repair|proof|events|step|evidence|verify|replan|event ...\n  /context [query] /departments [catalog|provision|handoff] /outcomes [slug|plan ...]\n  /apps [page] /connect <toolkit> /tools search <query>\n  /triggers /trigger create|enable|disable|delete ...\n  /channel list|link <provider>|notify <provider> on|off\n  /meetings [id] /meeting profile|prepare|join|join-prepared|context|leave ...\n  /workers [status] /worker <id> | cancel <id>\n  /skills [query] /skill <name> [file]\n  /artifacts [type] /artifact download|delete|package ...\n  /videos /video create|status|cancel ...\n  /runs [status] /run <prompt> | status|events|cancel|resume <id>\n  /webhooks /webhook add|enable|disable|delete ... /deliveries\n  /voice list|set twilio|meetings|bland <voice> /voice [on|off|status] /call <E.164 number> <purpose> /usage /info /export /dashboard /image <description>\n  /task <id> /task retry <id> /task cancel <id>\n  /attach <path> [instruction] /devices /revoke <name>\n  /model [id] /approve <id> /deny <id> /clear history /clear session /exit\n\n${formatStatus("Input", "Paste multiline text and press Enter to send; Ctrl+J inserts a newline.", color)}\n${formatStatus("Approvals", "Use /approvals for ↑/↓ selection; Enter confirms; Esc cancels. Deny is the safe default.", color)}\n${formatStatus("Long lists", "Space/↓ next, b/↑ previous, q quit. Chat responses scroll normally.", color)}\n${formatStatus("Cancel", "Ctrl+C cancels only the active request; it does not close Chusky.", color)}\n`); continue; }
      if (line.startsWith("/approve ") || line.startsWith("/deny ")) {
        const [command, id] = line.split(/\s+/, 2);
        const result = await client.approve(id, command === "/approve" ? "approve" : "deny");
        console.log(result.ok ? (result.text ? renderMarkdown(result.text, color) : formatSuccess("Done.", color)) : formatError(result.error || "Request failed.", color));
        continue;
      }
      if (line === "/autonomy" || line.startsWith("/autonomy ")) {
        const parts = line.trim().split(/\s+/);
        const action = parts[1] === "reconcile" || parts[1] === "refresh" ? parts[1] : "status";
        const mode = (parts[action === "status" ? 1 : 2] === "business" ? "business" : "personal") as "personal" | "business";
        if (action === "reconcile" || action === "refresh") {
          const maxWatches = Math.max(1, Math.min(20, Number(parts[3] ?? 8) || 8));
          const result = await client.autonomyReconcile(mode, maxWatches);
          if (!result.ok) console.log(formatError(result.error || "Autonomy reconciliation failed.", color));
          else console.log(formatSuccess(`Reconciled ${result.checked ?? 0} ${mode} watch${result.checked === 1 ? "" : "es"}.`, color) + (result.results?.length ? `\n${result.results.map((item: any) => `${item.watchId} [${item.status}] ${item.summary}${item.error ? ` — ${item.error}` : ""}`).join("\n")}` : ""));
        } else {
          const result = await client.autonomy(mode);
          if (!result.ok || !result.snapshot) console.log(formatError(result.error || "Could not load autonomy state.", color));
          else {
            const snapshot = result.snapshot;
            const counts = Object.entries(snapshot.counts ?? {}).filter(([key]) => !["blocked", "overdue"].includes(key)).map(([key, value]) => `${key}:${value}`).join("  ");
            console.log(`${formatStatus("Autonomy", `${snapshot.mode} · ${snapshot.profile.enabled ? "enabled" : "disabled"} · authority ${snapshot.profile.defaultAuthority}`, color)}\n${formatStatus("Queue", `${counts || "empty"} · blocked:${snapshot.counts.blocked ?? 0} · overdue:${snapshot.counts.overdue ?? 0}`, color)}\n${snapshot.queue.length ? snapshot.queue.slice(0, 20).map((item: any) => autonomyLine(item, color)).join("\n") : "No unfinished work or due checks."}`);
          }
        }
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
      if (line === "/meetings" || line.startsWith("/meetings ")) {
        const id = line.slice("/meetings".length).trim();
        if (id) {
          const result = await client.meeting(id);
          if (!result.ok || !result.meeting) console.log(formatError(result.error || "Could not load meeting.", color));
          else await showPaged(meetingDetail(result.meeting, result.contacts || [], color), true);
        } else {
          const result = await client.meetings();
          if (!result.ok) console.log(formatError(result.error || "Could not load meetings.", color));
          else {
            const prepared = result.preparations?.length ? `Prepared calendar meetings:\n${result.preparations.map((item: any) => `${item.id}  [${item.status}]  ${item.title || "Untitled"} — ${item.participants?.join(", ") || "no attendees"}${item.briefStatus ? ` — brief ${item.briefStatus}` : ""}`).join("\n")}` : "Prepared calendar meetings: none";
            const active = result.meetings?.length ? result.meetings.map((meeting: any) => meetingLine(meeting, color)).join("\n\n") : "No meetings.";
            const contacts = result.contacts?.length ? `\n\nCaptured contacts:\n${result.contacts.map((contact: any) => `${contact.id}  ${contact.participantName}  ${contact.email || contact.phone || "no contact"}`).join("\n")}` : "";
            await showPaged(`${prepared}\n\nMeetings:\n${active}${contacts}`, true);
          }
        }
        continue;
      }
      if (line === "/meeting" || line.startsWith("/meeting ")) {
        const raw = line.slice("/meeting".length).trim();
        const parts = raw.split(/\s+/); const action = (parts.shift() || "").toLowerCase();
        if (action === "profile") {
          if (parts[0] === "set") {
            const json = raw.slice("profile set".length).trim();
            try { const result = await client.updateMeetingProfile(JSON.parse(json)); console.log(result.ok ? formatSuccess("Meeting representative profile updated.", color) : formatError(result.error || "Could not update meeting profile.", color)); }
            catch { console.log(formatError("Usage: /meeting profile set <json>", color)); }
          } else {
            const result = await client.meetingProfile();
            console.log(result.ok ? JSON.stringify(result.profile, null, 2) : formatError(result.error || "Could not load meeting profile.", color));
          }
          continue;
        }
        if (action === "prepare") {
          const fields = raw.slice("prepare".length).trim().split("|").map((value) => value.trim());
          if (!fields[0]) console.log(formatError("Usage: /meeting prepare <client name> | <objective> | <context>", color));
          else {
            const result = await client.prepareMeeting({ clientName: fields[0], ...(fields[1] ? { objective: fields[1] } : {}), ...(fields[2] ? { clientContext: fields[2] } : {}) });
            console.log(result.ok ? `${formatSuccess("Meeting brief prepared.", color)}\n${JSON.stringify(result.brief, null, 2)}` : formatError(result.error || "Could not prepare meeting brief.", color));
          }
          continue;
        }
        if (action === "join-prepared") {
          const fields = raw.slice("join-prepared".length).trim().split("|").map((value) => value.trim());
          const id = fields[0];
          if (!id) console.log(formatError("Usage: /meeting join-prepared <preparation id> | <client name> | <objective> | <context>", color));
          else { const result = await client.joinPreparedMeeting(id, { ...(fields[1] ? { clientName: fields[1] } : {}), ...(fields[2] ? { objective: fields[2] } : {}), ...(fields[3] ? { clientContext: fields[3] } : {}) }); console.log(result.ok ? formatSuccess(`Prepared meeting join started${result.meeting?.id ? `: ${result.meeting.id}` : "."}`, color) : formatError(result.error || "Could not join prepared meeting.", color)); }
          continue;
        }
        if (action === "join") {
          const fields = raw.slice("join".length).trim().split("|").map((value) => value.trim());
          const meetingUrl = fields[0];
          if (!meetingUrl) console.log(formatError("Usage: /meeting join <meeting URL> | <client name> | <objective> | <context>", color));
          else {
            const result = await client.joinMeeting({ meetingUrl, ...(fields[1] ? { clientName: fields[1], objective: fields[2], clientContext: fields[3] } : {}) });
            console.log(result.ok ? formatSuccess(`Meeting join started${result.meeting?.id ? `: ${result.meeting.id}` : "."}`, color) : formatError(result.error || "Could not join meeting.", color));
          }
          continue;
        }
        if (action === "context") {
          const id = parts.shift(); const query = parts.join(" ");
          if (!id) console.log(formatError("Usage: /meeting context <meeting id> [question]", color));
          else { const result = await client.meetingContext(id, query); console.log(result.ok ? JSON.stringify(result.context, null, 2) : formatError(result.error || "Meeting context is unavailable.", color)); }
          continue;
        }
        if (action === "leave") {
          const id = parts[0];
          if (!id) console.log(formatError("Usage: /meeting leave <meeting id>", color));
          else { const result = await client.leaveMeeting(id); console.log(result.ok ? formatSuccess("Meeting leave requested.", color) : formatError(result.error || "Could not leave meeting.", color)); }
          continue;
        }
        if (action === "contact-delete") {
          const id = parts[0];
          if (!id) console.log(formatError("Usage: /meeting contact-delete <contact id>", color));
          else { const result = await client.deleteMeetingContact(id); console.log(result.ok ? formatSuccess("Meeting contact deleted.", color) : formatError(result.error || "Could not delete meeting contact.", color)); }
          continue;
        }
        console.log(formatError("Usage: /meeting profile | prepare <client> | join <url> | join-prepared <id> | context <id> [question] | leave <id>", color));
        continue;
      }
      if (line === "/voice" || line.startsWith("/voice ")) {
        const rawVoice = line.slice(6).trim(); const voiceParts = rawVoice.split(/\s+/); const action = (voiceParts.shift() || "status").toLowerCase();
        if (action === "list") {
          const result = await client.voiceOptions();
          if (!result.ok) console.log(formatError(result.error || "Could not load voice options.", color));
          else {
            const flux = Array.isArray(result.fluxVoices) ? result.fluxVoices.map((voice: any) => `${voice.id} — ${voice.name}${voice.accent ? ` (${voice.accent})` : ""}`).join("\n") : "No Flux voices.";
            const bland = Array.isArray(result.blandVoices) && result.blandVoices.length ? result.blandVoices.map((voice: any) => `${voice.id} — ${voice.name}`).join("\n") : "No Bland voices available.";
            await showPaged(`Flux / Twilio / Meetings:\n${flux}\n\nBland (${result.blandAvailable ? "available" : "unavailable"}):\n${bland}`, true);
          }
          continue;
        }
        if (action === "set") {
          const provider = voiceParts.shift(); const id = voiceParts.shift(); const name = voiceParts.join(" ");
          if ((provider !== "twilio" && provider !== "meetings" && provider !== "bland") || !id || (provider === "bland" && !name)) console.log(formatError("Usage: /voice set twilio|meetings <flux-voice-id> | /voice set bland <uuid> <name>", color));
          else {
            const result = await client.setLiveVoice(provider, provider === "bland" ? { id, name } : id);
            console.log(result.ok ? formatSuccess(`${provider} voice set to ${id}.`, color) : formatError(result.error || "Could not set voice.", color));
          }
          continue;
        }
        const result = await client.voice(action === "on" || action === "enable" ? true : action === "off" || action === "disable" ? false : undefined);
        console.log(result.ok ? `${formatSuccess(result.enabled ? "Voice replies are on." : "Voice replies are off.", color)}${result.voicePreferences ? `\nPreferences: ${JSON.stringify(result.voicePreferences)}` : ""}` : formatError(result.error || "Could not update voice replies.", color)); continue;
      }
      if (line === "/call" || line.startsWith("/call ")) {
        const raw = line.slice(5).trim(); const split = raw.search(/\s/);
        const phoneNumber = split < 0 ? raw : raw.slice(0, split); const purpose = split < 0 ? "" : raw.slice(split).trim();
        if (!phoneNumber || !purpose) { console.log(formatError("Usage: /call <E.164 phone number> <purpose>", color)); continue; }
        const result = await client.call(phoneNumber, purpose);
        const callId = result.call && typeof result.call === "object" ? String((result.call as { id?: unknown }).id ?? "") : "";
        console.log(result.ok ? formatSuccess(result.text || `Phone call started${callId ? ` · ${callId}` : ""}.`, color) : formatError(result.error || "Could not start phone call.", color));
        continue;
      }
      if (line === "/usage") { const result = await client.usage(); console.log(result.ok ? `${formatStatus("Usage", `${result.totalMessages} messages  •  $${Number(result.totalCost || 0).toFixed(5)}`, color)}\n${formatStatus("Context", `${result.historyTurns}/${result.maxHistory} turns`, color)}\n${formatStatus("Voice", result.voiceReplies ? "on" : "off", color)}` : formatError(result.error || "Could not load usage.", color)); continue; }
      if (line === "/dashboard") { const result = await client.dashboard(); console.log(result.ok ? `${formatSuccess("Dashboard:", color)} ${result.url}` : formatError(result.error || "Dashboard is not configured.", color)); continue; }
      if (line === "/export") {
        const current = await client.session(); if (!current.ok) { console.log(formatError(current.error || "Could not load session.", color)); continue; }
        const path = join(process.cwd(), `chusky-export-${Date.now()}.txt`); const text = [`Chusky AI Agent`, `Model: ${current.model}`, `Exported: ${new Date().toISOString()}`, "─".repeat(50), "", ...(current.history || []).flatMap((m: any) => [`[${m.role === "user" ? "You" : "Chusky"}]`, m.content, ""])].join("\n");
        await writeFile(path, text, "utf8"); console.log(formatSuccess(`Conversation exported to ${path}`, color)); continue;
      }
      if (line === "/history") { const items = await loadCollection(client, "history"); await showPaged(items.map((m) => `${m.role}: ${m.content}`).join("\n") || "No history.", true); continue; }
      if (line === "/workers" || line.startsWith("/workers ")) {
        const result = await client.workers(line.slice("/workers".length).trim());
        if (!result.ok) console.log(formatError(result.error || "Could not load workers.", color));
        else await showPaged(result.workers?.length ? result.workers.map((worker) => `${worker.id}  [${worker.status}]  ${worker.worker}\n${worker.objective}`).join("\n\n") : "No delegated workers.", true);
        continue;
      }
      if (line.startsWith("/worker ")) {
        const parts = line.slice("/worker ".length).trim().split(/\s+/); const action = parts[0] === "cancel" ? "cancel" : "get"; const id = action === "cancel" ? parts[1] : parts[0];
        if (!id) { console.log(formatError("Usage: /worker <id> | /worker cancel <id>", color)); continue; }
        const result = action === "cancel" ? await client.cancelWorker(id) : await client.worker(id);
        const worker: any = result.worker;
        console.log(result.ok && worker ? `${formatSuccess(`${worker.id} [${worker.status}]`, color)}\nWorker: ${worker.worker}\nObjective: ${worker.objective}\nExpected: ${worker.expectedOutput || "not specified"}` : formatError(result.error || "Worker not found.", color));
        continue;
      }
      if (line === "/skills" || line.startsWith("/skills ")) {
        const result = await client.skills(line.slice("/skills".length).trim());
        if (!result.ok) console.log(formatError(result.error || "Could not load skills.", color));
        else await showPaged(result.skills?.length ? result.skills.map((skill) => `${skill.name}\n${skill.description}`).join("\n\n") : "No matching skills.", true);
        continue;
      }
      if (line.startsWith("/skill ")) {
        const parts = line.slice("/skill ".length).trim().split(/\s+/); const name = parts.shift() || "";
        if (!name) { console.log(formatError("Usage: /skill <name> [file] | /skill files <name>", color)); continue; }
        if (name === "files") { const skillName = parts.shift(); if (!skillName) { console.log(formatError("Usage: /skill files <name>", color)); continue; } const result = await client.skillFiles(skillName); console.log(result.ok ? result.files.map((file) => `${file.path}  (${file.bytes} bytes${file.binary ? ", binary" : ""})`).join("\n") || "No skill files found." : formatError(result.error || "Skill not found.", color)); }
        else { const result = await client.skillRead(name, parts.join(" ") || "SKILL.md"); if (!result.ok) console.log(formatError(result.error || "Skill file not found.", color)); else await showPaged(`${paint(`${name}/${result.path}`, "cyan", color)}\n\n${result.content || "(binary or empty file)"}`, true); }
        continue;
      }
      if (line === "/artifacts" || line.startsWith("/artifacts ")) {
        const result = await client.artifacts(line.slice("/artifacts".length).trim());
        if (!result.ok) console.log(formatError(result.error || "Could not load artifacts.", color));
        else await showPaged(result.artifacts?.length ? result.artifacts.map((artifact) => `${artifact.id}  [${artifact.type}]  ${artifact.name}  (${artifact.size} bytes)`).join("\n") : "No artifacts.", true);
        continue;
      }
      if (line.startsWith("/artifact ")) {
        const parts = line.slice("/artifact ".length).trim().split(/\s+/); const action = parts.shift() || "";
        try {
          if (action === "download" && parts[0]) await saveDownloadedArtifact(client, parts[0], color);
          else if (action === "delete" && parts[0]) { const result = await client.deleteArtifact(parts[0]); console.log(result.ok ? formatSuccess(`Deleted artifact ${parts[0]}.`, color) : formatError(result.error || "Artifact could not be deleted.", color)); }
          else if (action === "package" && parts.length) { const result = await client.packageArtifacts(parts); console.log(result.ok ? formatSuccess(`Package created: ${result.artifact?.id || "queued"}.`, color) : formatError(result.error || "Package could not be created.", color)); }
          else console.log(formatError("Usage: /artifact download|delete <id> | /artifact package <workspace-file> [more files]", color));
        } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); }
        continue;
      }
      if (line === "/videos") {
        const result = await client.videos(); console.log(result.ok ? (result.videos?.map((video) => `${video.id}  [${video.status}]  ${video.destination}  ${video.prompt}`).join("\n") || "No video jobs.") : formatError(result.error || "Could not load video jobs.", color)); continue;
      }
      if (line.startsWith("/video ")) {
        const parts = line.slice("/video ".length).trim().split(/\s+/); const action = parts.shift() || "";
        if (action === "create") { const result = await client.createVideo({ prompt: parts.join(" ") }); console.log(result.ok ? formatSuccess(`Video queued: ${result.video?.id || "created"}.`, color) : formatError(result.error || "Video could not be queued.", color)); }
        else if ((action === "status" || action === "cancel") && parts[0]) { const result = action === "status" ? await client.video(parts[0]) : await client.cancelVideo(parts[0]); const video: any = result.video; console.log(result.ok && video ? `${video.id}  [${video.status}]  ${video.prompt}${video.error ? `\nError: ${video.error}` : ""}` : formatError(result.error || "Video job not found.", color)); }
        else console.log(formatError("Usage: /videos | /video create <prompt> | /video status|cancel <id>", color));
        continue;
      }
      if (line === "/runs" || line.startsWith("/runs ")) {
        const result = await client.runs(line.slice("/runs".length).trim());
        if (!result.ok) console.log(formatError(result.error || "Could not load runs.", color));
        else await showPaged(result.runs?.length ? result.runs.map((run) => `${run.id}  [${run.status}]  ${run.model || "default"}\n${run.input}`).join("\n\n") : "No durable runs.", true);
        continue;
      }
      if (line.startsWith("/run ")) {
        const raw = line.slice("/run ".length).trim(); const parts = raw.split(/\s+/); const action = ["status", "events", "cancel", "resume"].includes(parts[0]) ? parts.shift()! : "create";
        if (action === "create") { const durationIndex = parts.findIndex((item) => ["5m", "30m", "1h", "3h", "6h", "3d", "1w"].includes(item)); const duration = durationIndex >= 0 ? parts.splice(durationIndex, 1)[0] : "30m"; const modelFlag = parts.find((item) => item.startsWith("--model=")); const toolsFlag = parts.find((item) => item.startsWith("--max-tools=")); const costFlag = parts.find((item) => item.startsWith("--max-cost=")); const input = parts.filter((item) => !item.startsWith("--model=") && !item.startsWith("--max-tools=") && !item.startsWith("--max-cost=")).join(" "); const result = await client.createRun({ input, duration, ...(modelFlag ? { model: modelFlag.slice(8) } : {}), ...(toolsFlag ? { maxToolCalls: Number(toolsFlag.slice(12)) } : {}), ...(costFlag ? { maxCost: Number(costFlag.slice(11)) } : {}) }); console.log(result.ok ? formatSuccess(`Run queued: ${result.run?.id || "created"} (${duration}).`, color) : formatError(result.error || "Run could not be queued.", color)); }
        else if (parts[0]) { const id = parts[0]; const result = action === "status" ? await client.run(id) : action === "events" ? await client.runEvents(id) : action === "cancel" ? await client.cancelRun(id) : await client.resumeRun(id); if (action === "events") console.log(result.ok ? ((result.events as any[] | undefined)?.map((event: any) => `${new Date(event.at).toISOString()}  ${event.type}${event.text ? ` — ${event.text}` : ""}`).join("\n") || "No new events.") : formatError(result.error || "Run not found.", color)); else { const run: any = result.run; console.log(result.ok && run ? `${run.id}  [${run.status}]  ${run.model || "default"}\n${run.input}${run.output ? `\n\n${run.output}` : ""}${run.error ? `\nError: ${run.error.message}` : ""}` : formatError(result.error || "Run not found.", color)); } }
        else console.log(formatError("Usage: /run <prompt> [5m|30m|1h|3h|6h|3d|1w] | /run status|events|cancel|resume <id>", color));
        continue;
      }
      if (line === "/missions" || line.startsWith("/missions ")) {
        const id = line.slice("/missions".length).trim();
        if (!id) {
          const result = await client.missions();
          if (!result.ok) console.log(formatError(result.error || "Could not load missions.", color));
          else await showPaged(result.missions?.length ? result.missions.map((mission) => missionLine(mission, color)).join("\n") : "No autonomous missions.", true);
        } else {
          const result = await client.mission(id);
          if (!result.ok || !result.mission) console.log(formatError(result.error || "Mission not found.", color));
          else await showPaged(missionDetail(result.mission, color), true);
        }
        continue;
      }
      if (line === "/mission" || line.startsWith("/mission ")) {
        const raw = line.slice("/mission".length).trim();
        const parts = raw ? raw.split(/\s+/) : [];
        const action = parts.shift()?.toLowerCase() || "list";
        if (action === "list") {
          const result = await client.missions();
          if (!result.ok) console.log(formatError(result.error || "Could not load missions.", color));
          else await showPaged(result.missions?.length ? result.missions.map((mission) => missionLine(mission, color)).join("\n") : "No autonomous missions.", true);
        } else if (action === "create") {
          const fields = raw.slice("create".length).trim().split("|").map((value) => value.trim());
          if (!fields[0] || !fields[1] || !fields[2]) console.log(formatError("Usage: /mission create <title> | <objective> | <definition of done>", color));
          else { const result = await client.createMission({ title: fields[0], objective: fields[1], definitionOfDone: fields[2] }); console.log(result.ok ? formatSuccess(`Mission started: ${result.mission?.id || "queued"}.`, color) : formatError(result.error || "Mission could not be created.", color)); }
        } else if (["pause", "resume", "cancel", "repair"].includes(action)) {
          const id = parts[0];
          if (!id) console.log(formatError(`Usage: /mission ${action} <id>`, color));
          else { const result = await client.missionAction(id, action as "pause" | "resume" | "cancel" | "repair"); console.log(result.ok ? formatSuccess(`Mission ${action} requested: ${id}.`, color) : formatError(result.error || `Mission could not be ${action}d.`, color)); }
        } else if (["proof", "events"].includes(action)) {
          const id = parts[0];
          if (!id) console.log(formatError(`Usage: /mission ${action} <id>`, color));
          else if (action === "proof") { const result = await client.missionProof(id); console.log(result.ok && result.proof ? JSON.stringify(result.proof, null, 2) : formatError(result.error || "Mission proof is unavailable.", color)); }
          else { const result = await client.missionEvents(id); await showPaged(result.ok ? (result.events?.map((event) => `${new Date(event.at).toISOString()}  ${event.type}: ${event.message}`).join("\n") || "No mission events.") : formatError(result.error || "Mission events are unavailable.", color), true); }
        } else if (action === "step") {
          const id = parts.shift(); const stepId = parts.shift(); const resultText = parts.join(" ");
          if (!id || !stepId || !resultText) console.log(formatError("Usage: /mission step <mission id> <step id> <verified result>", color));
          else { const result = await client.completeMissionStep(id, stepId, resultText); console.log(result.ok ? formatSuccess(`Mission step completed: ${stepId}.`, color) : formatError(result.error || "Mission step could not be completed.", color)); }
        } else if (action === "evidence") {
          const id = parts.shift(); const json = raw.slice("evidence".length).trim().replace(/^\S+\s*/, "");
          if (!id || !json) console.log(formatError('Usage: /mission evidence <id> <JSON array, e.g. [{"kind":"source","summary":"...","verified":true}]>', color));
          else { try { const result = await client.addMissionEvidence(id, parseJson<any[]>(json, " /mission evidence <id> <JSON array>")); console.log(result.ok ? formatSuccess("Mission evidence recorded.", color) : formatError(result.error || "Mission evidence could not be recorded.", color)); } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); } }
        } else if (action === "verify") {
          const id = parts.shift();
          if (!id) console.log(formatError("Usage: /mission verify <id> [evidence-id,evidence-id]", color));
          else { const evidenceIds = parts[0] ? parts[0].split(",").map((value) => value.trim()).filter(Boolean) : undefined; const result = await client.verifyMission(id, evidenceIds ? { evidenceIds } : {}); console.log(result.ok ? formatSuccess(`Mission verification ${result.mission?.verification?.verified ? "passed" : "recorded"}.`, color) : formatError(result.error || "Mission verification failed.", color)); }
        } else if (action === "replan") {
          const id = parts.shift(); const remainder = raw.slice("replan".length).trim(); const divider = remainder.indexOf("|"); const reason = divider >= 0 ? remainder.slice(id?.length || 0, divider).trim() : "Verified information changed the remaining plan."; const json = divider >= 0 ? remainder.slice(divider + 1).trim() : remainder.slice(id?.length || 0).trim();
          if (!id || !json) console.log(formatError("Usage: /mission replan <id> <reason> | <steps JSON>", color));
          else { try { const result = await client.replanMission(id, { reason, steps: parseJson<any[]>(json, "/mission replan <id> <reason> | <steps JSON>") }); console.log(result.ok ? formatSuccess("Mission replanned.", color) : formatError(result.error || "Mission could not be replanned.", color)); } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); } }
        } else if (action === "event") {
          const id = parts[0]; const provider = parts[1]; const providerEventId = parts[2];
          if (!id || !provider || !providerEventId) console.log(formatError("Usage: /mission event <id> <provider> <provider event id>", color));
          else { const result = await client.missionProviderEvent(id, provider, providerEventId); console.log(result.ok ? formatSuccess("Mission provider event accepted; continuation queued.", color) : formatError(result.error || "Mission event was not accepted.", color)); }
        } else console.log(formatError("Usage: /missions [id] | /mission create|pause|resume|cancel|repair|proof|events|step|evidence|verify|replan|event ...", color));
        continue;
      }
      if (line === "/context" || line.startsWith("/context ")) {
        const raw = line.slice("/context".length).trim();
        if (raw.toLowerCase().startsWith("save ")) {
          try { const result = await client.saveContext(parseJson<any>(raw.slice(5).trim(), "/context save <context JSON>")); console.log(result.ok ? formatSuccess("Context saved.", color) : formatError(result.error || "Context could not be saved.", color)); } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); }
        } else {
          const result = await client.context(raw ? { query: raw } : {});
          if (!result.ok) console.log(formatError(result.error || "Could not load context.", color));
          else await showPaged(result.context?.length ? result.context.map((node) => `[${node.scope}/${node.kind}] ${node.key}: ${node.value}`).join("\n") : "No matching context.", true);
        }
        continue;
      }
      if (line === "/departments" || line.startsWith("/departments ")) {
        const raw = line.slice("/departments".length).trim(); const parts = raw.split(/\s+/).filter(Boolean); const action = parts.shift()?.toLowerCase() || "list";
        if (action === "catalog") { const result = await client.departmentCatalog(); await showPaged(result.ok ? result.departments.map((department) => `${department.slug} — ${department.name} (${department.worker})\n${department.objective}`).join("\n\n") : formatError(result.error || "Could not load department catalogue.", color), true); }
        else if (action === "provision") { const slug = parts[0]; if (!slug) console.log(formatError("Usage: /departments provision <slug>", color)); else { const result = await client.provisionDepartment({ department: slug }); console.log(result.ok ? formatSuccess(`Department provisioned: ${result.department?.name || slug}.`, color) : formatError(result.error || "Department could not be provisioned.", color)); } }
        else if (action === "handoff") { const department = parts.shift(); const objective = parts.join(" "); if (!department || !objective) console.log(formatError("Usage: /departments handoff <department> <objective>", color)); else { const result = await client.departmentHandoff(department, { objective }); console.log(result.ok ? formatSuccess(`Handoff queued: ${result.handoff?.id || "created"}.`, color) : formatError(result.error || "Handoff could not be created.", color)); } }
        else { const result = await client.departments(); await showPaged(result.ok ? (result.departments?.map((department) => `${department.id}  ${department.name} [${department.department}]\n${department.mission || department.objectives.join("; ")}`).join("\n\n") || "No department spaces provisioned.") : formatError(result.error || "Could not load departments.", color), true); }
        continue;
      }
      if (line === "/outcomes" || line.startsWith("/outcomes ")) {
        const raw = line.slice("/outcomes".length).trim(); const parts = raw.split(/\s+/).filter(Boolean); const action = parts.shift()?.toLowerCase() || "list";
        if (action === "list") { const result = await client.outcomes(); await showPaged(result.ok ? result.outcomes.map((outcome) => `${outcome.slug} — ${outcome.name}\n${outcome.description}`).join("\n\n") : formatError(result.error || "Could not load outcomes.", color), true); }
        else if (action === "plan") { const slug = parts.shift(); const json = parts.join(" ") || "{}"; if (!slug) console.log(formatError("Usage: /outcomes plan <slug> <inputs JSON>", color)); else { try { const result = await client.planOutcome(slug, parseJson<Record<string, unknown>>(json, "/outcomes plan <slug> <inputs JSON>")); console.log(result.ok && result.plan ? JSON.stringify(result.plan, null, 2) : formatError(result.error || "Outcome could not be planned.", color)); } catch (error) { console.log(formatError(error instanceof Error ? error.message : String(error), color)); } } }
        else { const result = await client.outcome(action); console.log(result.ok && result.outcome ? `${result.outcome.name}\n\n${result.outcome.description}\n\nSuccess criteria:\n${result.outcome.successCriteria.map((item) => `- ${item}`).join("\n")}` : formatError(result.error || "Outcome package not found.", color)); }
        continue;
      }
      if (line === "/webhooks") { const result = await client.webhooks(); console.log(result.ok ? (result.webhooks?.map((hook) => `${hook.id}  [${hook.disabledAt ? "disabled" : "enabled"}]  ${hook.url}`).join("\n") || "No webhooks.") : formatError(result.error || "Could not load webhooks.", color)); continue; }
      if (line.startsWith("/webhook ")) { const parts = line.slice("/webhook ".length).trim().split(/\s+/); const action = parts.shift() || ""; const id = parts.shift(); let result: any; if (action === "add" && id) result = await client.createWebhook(id); else if (["enable", "disable"].includes(action) && id) result = await client.setWebhook(id, action === "enable"); else if (action === "delete" && id) result = await client.deleteWebhook(id); else { console.log(formatError("Usage: /webhook add <https-url> | enable|disable|delete <id>", color)); continue; } console.log(result.ok ? formatSuccess(action === "add" ? `Webhook created${result.secret ? `; secret: ${result.secret}` : ""}.` : `Webhook ${action} completed.`, color) : formatError(result.error || "Webhook operation failed.", color)); continue; }
      if (line === "/deliveries") { const result = await client.deliveries(); console.log(result.ok ? (result.deliveries?.map((delivery) => `${delivery.id}  [${delivery.status}]  ${delivery.provider}  ${delivery.kind}${delivery.lastError ? ` — ${delivery.lastError}` : ""}`).join("\n") || "No deliveries.") : formatError(result.error || "Could not load deliveries.", color)); continue; }
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
      const automationCommand = line.match(/^\/(reminders|jobs)\s+(pause|resume|run|cancel)\s+(\S+)$/);
      if (automationCommand) {
        const [, kind, action, id] = automationCommand;
        const result = kind === "reminders"
          ? await client.reminderAction(id, action as "pause" | "resume" | "run" | "cancel")
          : await client.jobAction(id, action as "pause" | "resume" | "run" | "cancel");
        console.log(result.ok ? formatSuccess(`${kind === "reminders" ? "Reminder" : "Job"} ${action} requested.`, color) : formatError(result.error || "Automation action failed.", color));
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
        if (line === "/jobs") { const items = await loadCollection(client, "jobs"); await showPaged(items.length ? items.map((j: any) => `${j.id} — [${j.status}] — ${j.cron} — ${j.text}`).join("\n") : "No active jobs.", true); }
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
