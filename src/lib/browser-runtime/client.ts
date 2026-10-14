import { createHmac } from "node:crypto";

export type DedicatedBrowserClientOptions = { baseUrl: string; token: string; ownerSigningSecret: string; timeoutMs?: number };

export class DedicatedBrowserRuntimeClient {
  private readonly baseUrl: string;
  constructor(private readonly options: DedicatedBrowserClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("Dedicated browser runtime must use HTTPS in production");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async start(ownerScope: string, input: { startUrl: string; profileId?: string; headful?: boolean; region?: string }): Promise<Record<string, unknown>> {
    return this.request(ownerScope, "/v1/sessions", { method: "POST", body: input });
  }

  async observe(ownerScope: string, sessionId: string, input: { screenshot?: string; screenshotReason?: string; includeFrames?: boolean; includeForms?: boolean; region?: { x: number; y: number; width: number; height: number } }): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/observe`, { method: "POST", body: input });
  }

  async action(ownerScope: string, sessionId: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/action`, { method: "POST", body: action });
  }

  async upload(ownerScope: string, sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/upload`, { method: "POST", body: input });
  }

  async session(ownerScope: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
  }

  async liveView(ownerScope: string, sessionId: string, mode: "read-only" | "interactive" = "read-only"): Promise<Record<string, unknown>> {
    const query = mode === "interactive" ? "?mode=interactive" : "";
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/live-view${query}`, { method: "GET" });
  }

  async artifact(ownerScope: string, sessionId: string, artifactId: string): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", this.options.ownerSigningSecret).update(`${timestamp}.${ownerScope}`).digest("hex");
    const response = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.options.token}`, "x-chusky-owner-scope": ownerScope, "x-chusky-owner-timestamp": timestamp, "x-chusky-owner-signature": signature },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`dedicated browser artifact request failed (${response.status}): ${payload.slice(0, 300) || "unknown_error"}`);
    }
    return { name: response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${artifactId}.bin`, contentType: response.headers.get("content-type") ?? "application/octet-stream", bytes: Buffer.from(await response.arrayBuffer()) };
  }

  async stop(ownerScope: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", body: {} });
  }

  async waitForChallenge(ownerScope: string, sessionId: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/challenge/wait`, { method: "POST", body: { timeoutMs } });
  }

  async handoff(ownerScope: string, sessionId: string, reason = "owner_requested_handoff"): Promise<Record<string, unknown>> {
    return this.request(ownerScope, `/v1/sessions/${encodeURIComponent(sessionId)}/challenge/handoff`, { method: "POST", body: { reason } });
  }

  private async request(ownerScope: string, path: string, input: { method: "GET" | "POST"; body?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", this.options.ownerSigningSecret).update(`${timestamp}.${ownerScope}`).digest("hex");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: input.method,
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", "x-chusky-owner-scope": ownerScope, "x-chusky-owner-timestamp": timestamp, "x-chusky-owner-signature": signature },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`dedicated browser runtime request failed (${response.status}): ${String(payload.error ?? "unknown_error")}`);
    return payload;
  }
}
