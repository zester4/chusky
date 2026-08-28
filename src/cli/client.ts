import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig { serverUrl: string; token?: string; deviceName?: string; color?: boolean; }
export interface CliSession {
  userId: number; device: string; model: string;
  history: { role: string; content: string }[];
  approvals: { id: string; toolSlug: string; args: Record<string, unknown> }[];
  memories?: { category: string; key: string; value: string }[];
  scratchpad?: Record<string, { content: string; updatedAt: number }>;
  reminders?: { id: string; runAt: number; text: string }[];
  jobs?: { id: string; cron: string; text: string }[];
}
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
    return { ...saved, serverUrl: process.env.CHUSKY_SERVER_URL || saved.serverUrl || "" };
  }
  catch { return { serverUrl: process.env.CHUSKY_SERVER_URL || "" }; }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getCliConfigPath(): string { return configPath; }

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
}
