import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cliSecretBackend, loadCliSecret, saveCliSecret } from "./secrets.js";

export interface CliConfig { serverUrl: string; token?: string; deviceName?: string; color?: boolean; }
export interface CliSession {
  userId: number; device: string; model: string;
  history: { role: string; content: string }[];
  historyCount?: number; historyPage?: number; historyPageSize?: number; historyTotalPages?: number; memoryCount?: number; scratchpadCount?: number;
  approvals: { id: string; toolSlug: string; args: Record<string, unknown> }[];
  memories?: { category: string; key: string; value: string }[];
  scratchpad?: Record<string, { content: string; updatedAt: number }>;
  reminders?: { id: string; runAt: number; text: string }[];
  jobs?: { id: string; cron: string; text: string }[];
  tasks?: CliTask[];
}
export interface CliTaskEvent { id: string; type: string; message: string; at: number; attempt: number; }
export interface CliTask {
  id: string; userId: number; title: string; objective: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  checkpoint?: string; nextAction?: string; result?: string; error?: string;
  attempt: number; maxAttempts: number; runAt?: number; updatedAt: number; events: CliTaskEvent[];
}
export interface CliDevice { name: string; createdAt: number; lastSeenAt: number; }
export interface CliEventsResponse extends CliResponse { now: number; tasks: CliTask[]; runs?: CliRun[]; approvals: CliSession["approvals"]; reminders: { id: string; text: string; runAt: number; status: string }[]; jobs: { id: string; text: string; cron: string; status: string }[]; }
export interface CliCollectionResponse extends CliResponse { kind: string; page: number; pageSize: number; total: number; totalPages: number; items: unknown[]; }
export interface CliResponse { ok: boolean; text?: string; error?: string; approval?: { id: string; toolSlug: string; args: Record<string, unknown> }; [key: string]: unknown; }
export interface CliModel { id: string; name: string; }
export interface CliModelsResponse extends CliResponse { page: number; pageSize: number; totalPages: number; total: number; models: CliModel[]; }
export interface CliAppsResponse extends CliResponse { apps: { slug: string; name: string; connected: boolean; logo?: string }[]; }
export interface CliTriggersResponse extends CliResponse { triggers: unknown[]; }
export interface CliChannelsResponse extends CliResponse { channels: { provider: string; externalUserId: string; workspaceId?: string; displayName?: string; proactiveOptIn?: boolean }[]; }
export interface CliGeneratedFile { data: string; name: string; contentType: string; artifactId?: string; type?: string; }
export interface CliWorker { id: string; worker: string; from: string; objective: string; expectedOutput: string; status: string; taskId?: string; workflowRunId?: string; timestamp: string; delegation?: Record<string, unknown>; context?: Record<string, unknown>; }
export interface CliSkill { name: string; description: string; path: string; score?: number; files?: number; }
export interface CliSkillFile { name?: string; path: string; bytes: number; binary: boolean; content?: string; truncated?: boolean; }
export interface CliArtifact { id: string; name: string; type: string; path: string; contentType: string; size: number; status: string; sandboxId: string; createdAt: string; updatedAt: string; }
export interface CliVideoJob { id: string; prompt: string; destination: "telegram" | "daytona" | "both"; status: string; pollCount: number; workspacePath?: string; workflowRunId?: string; resultPath?: string; error?: string; createdAt: string; updatedAt: string; completedAt?: string; }
export interface CliRun { id: string; threadId?: string; taskId?: string; status: string; input: string; model?: string; output?: string; budget?: Record<string, unknown>; error?: { code: string; message: string }; events?: { id: string; type: string; at: number; text?: string }[]; createdAt: string; updatedAt: string; }
export interface CliWebhook { id: string; url: string; createdAt: string; disabledAt?: string; }
export interface CliDelivery { id: string; provider: string; status: string; kind: string; attempts: number; providerStatus?: string; lastError?: string; createdAt: string; updatedAt: string; deliveredAt?: string; }
export type CliStreamEvent = { type: "start" | "delta" | "done" | "approval_required" | "error"; text?: string; error?: string; model?: string; toolsUsed?: string[]; cost?: number; approval?: { id: string; toolSlug: string; args: Record<string, unknown> }; images?: { data: string; mediaType: string }[]; files?: CliGeneratedFile[]; speech?: { data: string; mediaType: string } };

const configPath = process.platform === "win32"
  ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Chusky", "config.json")
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "chusky", "config.json");

export async function loadCliConfig(): Promise<CliConfig> {
  try {
    const saved = JSON.parse(await readFile(configPath, "utf8")) as CliConfig;
    const serverUrl = process.env.CHUSKY_SERVER_URL || saved.serverUrl || "";
    const token = saved.token || (serverUrl ? await loadCliSecret(configPath, serverUrl) : undefined);
    // Migrate old plaintext config files on the next successful read when a
    // native vault or encrypted fallback is available.
    if (saved.token && serverUrl && cliSecretBackend() !== "legacy-file") {
      void saveCliConfig({ ...saved, serverUrl, token: saved.token }).catch(() => undefined);
    }
    return { ...saved, serverUrl, ...(token ? { token } : {}) };
  }
  catch { return { serverUrl: process.env.CHUSKY_SERVER_URL || "" }; }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const { token, ...publicConfig } = config;
  const stored = token && config.serverUrl ? await saveCliSecret(configPath, config.serverUrl, token) : false;
  await writeFile(configPath, JSON.stringify(stored ? publicConfig : config, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getCliConfigPath(): string { return configPath; }
export function getCliSecretBackend(): ReturnType<typeof cliSecretBackend> { return cliSecretBackend(); }

export class ChuskyClient {
  constructor(private readonly config: CliConfig) {}
  private async request(path: string, init: RequestInit = {}): Promise<CliResponse> {
    if (!this.config.serverUrl) throw new Error("Set CHUSKY_SERVER_URL or run: chusky auth link --server https://your-chusky-host");
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const signal = init.signal ?? AbortSignal.timeout(120000);
    const response = await fetch(`${this.config.serverUrl.replace(/\/$/, "")}${path}`, { ...init, headers, signal });
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` })) as CliResponse;
    if (!response.ok && !data.error) data.error = `HTTP ${response.status}`;
    return data;
  }
  pair(code: string, deviceName: string) { return this.request("/cli/pair", { method: "POST", body: JSON.stringify({ code, deviceName }) }); }
  session() { return this.request("/cli/session") as Promise<CliResponse & CliSession>; }
  chat(message: string, approvalId?: string, signal?: AbortSignal) { return this.request("/cli/chat", { method: "POST", body: JSON.stringify({ message, ...(approvalId ? { approvalId } : {}) }), signal }); }
  async *stream(message: string, signal?: AbortSignal): AsyncGenerator<CliStreamEvent> {
    if (!this.config.serverUrl) throw new Error("Set CHUSKY_SERVER_URL or run: chusky auth link --server https://your-chusky-host");
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/x-ndjson" });
    if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const response = await fetch(`${this.config.serverUrl.replace(/\/$/, "")}/cli/chat/stream`, { method: "POST", headers, body: JSON.stringify({ message }), signal: signal ?? AbortSignal.timeout(120000) });
    if (!response.ok) { const data = await response.json().catch(() => ({})) as CliResponse; throw new Error(data.error || `HTTP ${response.status}`); }
    if (!response.body) throw new Error("Chusky returned an empty stream");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as CliStreamEvent;
      if (done) break;
    }
  }
  approve(approvalId: string, decision: "approve" | "deny") { return this.request("/cli/approve", { method: "POST", body: JSON.stringify({ approvalId, decision }) }); }
  model(model: string) { return this.request("/cli/model", { method: "POST", body: JSON.stringify({ model }) }); }
  models(page = 1, pageSize = 10, query = "") { return this.request(`/cli/models?page=${page}&pageSize=${pageSize}&query=${encodeURIComponent(query)}`) as Promise<CliModelsResponse>; }
  apps(page = 1, pageSize = 15) { return this.request(`/cli/apps?page=${Math.max(1, page)}&pageSize=${Math.min(50, Math.max(1, pageSize))}`) as Promise<CliAppsResponse & { page: number; pageSize: number; totalPages: number; total: number }>; }
  connect(toolkit: string) { return this.request("/cli/connect", { method: "POST", body: JSON.stringify({ toolkit }) }); }
  tools(query: string) { return this.request(`/cli/tools?query=${encodeURIComponent(query)}`); }
  triggers() { return this.request("/cli/triggers") as Promise<CliTriggersResponse>; }
  trigger(action: "create" | "enable" | "disable" | "delete", value: string, triggerConfig?: Record<string, unknown>) { return this.request("/cli/triggers", { method: "POST", body: JSON.stringify({ action, value, triggerConfig }) }); }
  channels() { return this.request("/cli/channels") as Promise<CliChannelsResponse>; }
  channelLink(provider: string) { return this.request("/cli/channels/link", { method: "POST", body: JSON.stringify({ provider }) }); }
  channelNotify(provider: string, enabled: boolean) { return this.request("/cli/channels/notify", { method: "POST", body: JSON.stringify({ provider, enabled }) }); }
  voice(enabled?: boolean) { return this.request("/cli/voice", { method: "POST", body: JSON.stringify({ ...(enabled === undefined ? {} : { enabled }) }) }); }
  call(phoneNumber: string, purpose: string) { return this.request("/cli/call", { method: "POST", body: JSON.stringify({ phoneNumber, purpose }) }); }
  usage() { return this.request("/cli/usage"); }
  dashboard() { return this.request("/cli/dashboard"); }
  clear(scope: "history" | "session") { return this.request("/cli/clear", { method: "POST", body: JSON.stringify({ scope }) }); }
  tasks() { return this.request("/cli/tasks") as Promise<CliResponse & { tasks: CliTask[] }>; }
  taskAction(id: string, action: "cancel" | "retry") { return this.request(`/cli/tasks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }) as Promise<CliResponse & { task?: CliTask }>; }
  devices() { return this.request("/cli/devices") as Promise<CliResponse & { devices: CliDevice[] }>; }
  revokeDevice(name: string) { return this.request(`/cli/devices/${encodeURIComponent(name)}`, { method: "DELETE" }); }
  events(since = 0) { return this.request(`/cli/events?since=${Math.max(0, Math.floor(since))}`) as Promise<CliEventsResponse>; }
  collection(kind: "history" | "memories" | "scratchpad" | "reminders" | "jobs", page = 1, pageSize = 25, query = "") { return this.request(`/cli/collection/${kind}?page=${Math.max(1, Math.floor(page))}&pageSize=${Math.max(1, Math.floor(pageSize))}&query=${encodeURIComponent(query)}`) as Promise<CliCollectionResponse>; }
  async *eventStream(since = 0, signal?: AbortSignal): AsyncGenerator<CliEventsResponse> {
    if (!this.config.serverUrl) throw new Error("Set CHUSKY_SERVER_URL or run: chusky auth link --server https://your-chusky-host");
    const headers = new Headers({ Accept: "text/event-stream" }); if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const response = await fetch(`${this.config.serverUrl.replace(/\/$/, "")}/cli/events/stream?since=${Math.max(0, Math.floor(since))}`, { headers, signal: signal ?? AbortSignal.timeout(30 * 60_000) });
    if (!response.ok) { const data = await response.json().catch(() => ({})) as CliResponse; throw new Error(data.error || `HTTP ${response.status}`); }
    if (!response.body) throw new Error("Chusky returned an empty event stream");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let data = ""; let eventName = "message";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7);
          if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data && eventName === "notification") { yield JSON.parse(data) as CliEventsResponse; }
        data = ""; eventName = "message";
      }
      if (done) break;
    }
  }
  async media(file: Blob, filename: string, message = "", signal?: AbortSignal): Promise<CliResponse> {
    if (!this.config.serverUrl) throw new Error("Set CHUSKY_SERVER_URL or run: chusky auth link --server https://your-chusky-host");
    const form = new FormData(); form.append("file", file, filename); if (message) form.append("message", message);
    const headers = new Headers(); if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const response = await fetch(`${this.config.serverUrl.replace(/\/$/, "")}/cli/media`, { method: "POST", headers, body: form, signal: signal ?? AbortSignal.timeout(120000) });
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` })) as CliResponse;
    if (!response.ok && !data.error) data.error = `HTTP ${response.status}`;
    return data;
  }
  workers(status = "") { return this.request(`/cli/workers${status ? `?status=${encodeURIComponent(status)}` : ""}`) as Promise<CliResponse & { workers: CliWorker[] }>; }
  worker(id: string) { return this.request(`/cli/workers/${encodeURIComponent(id)}`) as Promise<CliResponse & { worker?: CliWorker }>; }
  createWorker(input: { worker: string; objective: string; expectedOutput?: string; model?: string; duration?: string; maxToolCalls?: number }) { return this.request("/cli/workers", { method: "POST", body: JSON.stringify(input) }) as Promise<CliResponse & { worker?: CliWorker }>; }
  cancelWorker(id: string) { return this.request(`/cli/workers/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }) as Promise<CliResponse & { worker?: CliWorker }>; }
  skills(query = "", limit = 20) { return this.request(`/cli/skills?limit=${Math.max(1, Math.min(20, limit))}${query ? `&query=${encodeURIComponent(query)}` : ""}`) as Promise<CliResponse & { skills: CliSkill[] }>; }
  skillFiles(name: string) { return this.request(`/cli/skills/${encodeURIComponent(name)}/files`) as Promise<CliResponse & { files: CliSkillFile[] }>; }
  skillRead(name: string, path = "SKILL.md", maxChars = 12000) { return this.request(`/cli/skills/${encodeURIComponent(name)}/read?path=${encodeURIComponent(path)}&maxChars=${maxChars}`) as Promise<CliResponse & CliSkillFile>; }
  artifacts(type = "") { return this.request(`/cli/artifacts${type ? `?type=${encodeURIComponent(type)}` : ""}`) as Promise<CliResponse & { artifacts: CliArtifact[] }>; }
  artifact(id: string) { return this.request(`/cli/artifacts/${encodeURIComponent(id)}`) as Promise<CliResponse & { artifact?: CliArtifact }>; }
  deleteArtifact(id: string) { return this.request(`/cli/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  packageArtifacts(files: string[], name = "chusky-project.zip") { return this.request("/cli/artifacts/package", { method: "POST", body: JSON.stringify({ files, name }) }) as Promise<CliResponse & { artifact?: CliArtifact }>; }
  async downloadArtifact(id: string): Promise<{ name: string; contentType: string; data: Uint8Array }> {
    if (!this.config.serverUrl) throw new Error("Set CHUSKY_SERVER_URL or run: chusky auth link --server https://your-chusky-host");
    const headers = new Headers({ Accept: "application/octet-stream" }); if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const response = await fetch(`${this.config.serverUrl.replace(/\/$/, "")}/cli/artifacts/${encodeURIComponent(id)}/download`, { headers, signal: AbortSignal.timeout(120000) });
    if (!response.ok) { const data = await response.json().catch(() => ({})) as CliResponse; throw new Error(data.error || `HTTP ${response.status}`); }
    return { name: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] || `${id}.bin`, contentType: response.headers.get("content-type") || "application/octet-stream", data: new Uint8Array(await response.arrayBuffer()) };
  }
  videos() { return this.request("/cli/videos") as Promise<CliResponse & { videos: CliVideoJob[] }>; }
  createVideo(input: { prompt: string; destination?: "telegram" | "daytona" | "both"; workspacePath?: string; duration?: number; aspectRatio?: string; resolution?: string; generateAudio?: boolean }) { return this.request("/cli/videos", { method: "POST", body: JSON.stringify(input) }) as Promise<CliResponse & { video?: CliVideoJob }>; }
  video(id: string) { return this.request(`/cli/videos/${encodeURIComponent(id)}`) as Promise<CliResponse & { video?: CliVideoJob }>; }
  cancelVideo(id: string) { return this.request(`/cli/videos/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }) as Promise<CliResponse & { video?: CliVideoJob }>; }
  runs(status = "") { return this.request(`/cli/runs${status ? `?status=${encodeURIComponent(status)}` : ""}`) as Promise<CliResponse & { runs: CliRun[] }>; }
  run(id: string) { return this.request(`/cli/runs/${encodeURIComponent(id)}`) as Promise<CliResponse & { run?: CliRun }>; }
  createRun(input: { input: string; model?: string; duration?: string; maxToolCalls?: number; maxCost?: number }) { return this.request("/cli/runs", { method: "POST", body: JSON.stringify(input) }) as Promise<CliResponse & { run?: CliRun }>; }
  runEvents(id: string, after = 0) { return this.request(`/cli/runs/${encodeURIComponent(id)}/events?after=${after}`) as Promise<CliResponse & { events: CliRun["events"] }>; }
  cancelRun(id: string) { return this.request(`/cli/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }) as Promise<CliResponse & { run?: CliRun }>; }
  resumeRun(id: string) { return this.request(`/cli/runs/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }) as Promise<CliResponse & { run?: CliRun }>; }
  webhooks() { return this.request("/cli/webhooks") as Promise<CliResponse & { webhooks: CliWebhook[] }>; }
  createWebhook(url: string) { return this.request("/cli/webhooks", { method: "POST", body: JSON.stringify({ url }) }) as Promise<CliResponse & { webhook?: CliWebhook; secret?: string }>; }
  setWebhook(id: string, enabled: boolean) { return this.request(`/cli/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); }
  deleteWebhook(id: string) { return this.request(`/cli/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  deliveries() { return this.request("/cli/deliveries") as Promise<CliResponse & { deliveries: CliDelivery[] }>; }
}
