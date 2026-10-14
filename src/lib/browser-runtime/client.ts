import { createHmac } from "node:crypto";

export type DedicatedBrowserClientOptions = { baseUrl: string; token: string; ownerSigningSecret: string; timeoutMs?: number };

export type DedicatedBrowserRuntimeRegion = { id: string; baseUrl: string };

export class DedicatedBrowserRuntimeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DedicatedBrowserRuntimeError";
  }
}

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
      throw new DedicatedBrowserRuntimeError(`dedicated browser artifact request failed (${response.status}): ${payload.slice(0, 300) || "unknown_error"}`, response.status);
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
    if (!response.ok) throw new DedicatedBrowserRuntimeError(`dedicated browser runtime request failed (${response.status}): ${String(payload.error ?? "unknown_error")}`, response.status);
    return payload;
  }
}

/**
 * Routes a browser session to one deployed regional runtime. Start is the only
 * operation allowed to fail over: once a session exists, every operation is
 * pinned to its recorded region so an uncertain click is never replayed in a
 * different browser.
 */
export class DedicatedBrowserRuntimePool {
  private readonly clients = new Map<string, DedicatedBrowserRuntimeClient>();
  private readonly sessionRegions = new Map<string, string>();
  private cursor = 0;

  constructor(
    regions: readonly DedicatedBrowserRuntimeRegion[],
    private readonly options: Omit<DedicatedBrowserClientOptions, "baseUrl"> & { defaultRegion?: string },
  ) {
    for (const region of regions) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(region.id)) throw new Error("browser runtime region id is invalid");
      this.clients.set(region.id, new DedicatedBrowserRuntimeClient({ ...options, baseUrl: region.baseUrl }));
    }
    if (!this.clients.size) throw new Error("at least one dedicated browser runtime region is required");
  }

  bindSession(sessionId: string, region?: string): void {
    if (!region) return;
    if (!this.clients.has(region)) throw new Error(`dedicated browser session region is not configured: ${region}`);
    this.sessionRegions.set(sessionId, region);
  }

  async start(ownerScope: string, input: { startUrl: string; profileId?: string; headful?: boolean; region?: string }): Promise<Record<string, unknown>> {
    const candidates = this.startCandidates(input.region);
    let lastError: unknown;
    for (const region of candidates) {
      try {
        const client = this.clients.get(region)!;
        const result = await client.start(ownerScope, { ...input, ...(region === "default" ? {} : { region }) });
        const sessionId = typeof result.id === "string" ? result.id : undefined;
        if (sessionId) this.sessionRegions.set(sessionId, region);
        return { ...result, runtimeRegion: region };
      } catch (error) {
        lastError = error;
        if (!isRuntimeAvailabilityError(error)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all dedicated browser runtime regions are unavailable");
  }

  async observe(ownerScope: string, sessionId: string, input: Parameters<DedicatedBrowserRuntimeClient["observe"]>[2]) { return this.clientFor(sessionId).observe(ownerScope, sessionId, input); }
  async action(ownerScope: string, sessionId: string, action: Record<string, unknown>) { return this.clientFor(sessionId).action(ownerScope, sessionId, action); }
  async upload(ownerScope: string, sessionId: string, input: Record<string, unknown>) { return this.clientFor(sessionId).upload(ownerScope, sessionId, input); }
  async session(ownerScope: string, sessionId: string) { return this.clientFor(sessionId).session(ownerScope, sessionId); }
  async liveView(ownerScope: string, sessionId: string, mode: "read-only" | "interactive" = "read-only") { return this.clientFor(sessionId).liveView(ownerScope, sessionId, mode); }
  async artifact(ownerScope: string, sessionId: string, artifactId: string) { return this.clientFor(sessionId).artifact(ownerScope, sessionId, artifactId); }

  async stop(ownerScope: string, sessionId: string) {
    try { return await this.clientFor(sessionId).stop(ownerScope, sessionId); }
    finally { this.sessionRegions.delete(sessionId); }
  }

  async waitForChallenge(ownerScope: string, sessionId: string, timeoutMs = 20_000) { return this.clientFor(sessionId).waitForChallenge(ownerScope, sessionId, timeoutMs); }
  async handoff(ownerScope: string, sessionId: string, reason = "owner_requested_handoff") { return this.clientFor(sessionId).handoff(ownerScope, sessionId, reason); }

  regions(): string[] { return [...this.clients.keys()]; }

  private clientFor(sessionId: string): DedicatedBrowserRuntimeClient {
    const region = this.sessionRegions.get(sessionId) ?? this.options.defaultRegion ?? this.clients.keys().next().value;
    const client = region ? this.clients.get(region) : undefined;
    if (!client) throw new Error(`dedicated browser session region is not configured: ${String(region)}`);
    return client;
  }

  private startCandidates(requested?: string): string[] {
    const regions = [...this.clients.keys()];
    if (requested) {
      if (!this.clients.has(requested)) throw new Error(`dedicated browser runtime region is not configured: ${requested}`);
      return [requested, ...regions.filter((region) => region !== requested)];
    }
    const preferred = this.options.defaultRegion && this.clients.has(this.options.defaultRegion) ? this.options.defaultRegion : undefined;
    const start = preferred ? regions.indexOf(preferred) : this.cursor++ % regions.length;
    return regions.slice(start).concat(regions.slice(0, start));
  }
}

function isRuntimeAvailabilityError(error: unknown): boolean {
  if (error instanceof DedicatedBrowserRuntimeError) return [408, 429, 500, 502, 503, 504].includes(error.status ?? 0);
  return /fetch failed|network|timeout|timed out|ECONN|ENET|EHOST|socket/i.test(error instanceof Error ? error.message : String(error));
}
