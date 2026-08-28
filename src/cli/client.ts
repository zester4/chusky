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
export interface CliEventsResponse extends CliResponse { now: number; tasks: CliTask[]; approvals: CliSession["approvals"]; reminders: { id: string; text: string; runAt: number; status: string }[]; jobs: { id: string; text: string; cron: string; status: string }[]; }
export interface CliCollectionResponse extends CliResponse { kind: string; page: number; pageSize: number; total: number; totalPages: number; items: unknown[]; }
export interface CliResponse { ok: boolean; text?: string; error?: string; approval?: { id: string; toolSlug: string; args: Record<string, unknown> }; [key: string]: unknown; }
export interface CliModel { id: string; name: string; }
export interface CliModelsResponse extends CliResponse { page: number; pageSize: number; totalPages: number; total: number; models: CliModel[]; }
export type CliStreamEvent = { type: "start" | "delta" | "done" | "approval_required" | "error"; text?: string; error?: string; model?: string; toolsUsed?: string[]; cost?: number; approval?: { id: string; toolSlug: string; args: Record<string, unknown> }; images?: { data: string; mediaType: string }[] };

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
}
