import { ChuskyAuthenticationError, ChuskyError, ChuskyRateLimitError } from "./errors.js";
import { readNdjson } from "./stream.js";
import type { Approval, ChuskyClientOptions, CreateRunParams, CreateThreadParams, Page, RequestOptions, Run, RunStreamEvent, Task, Thread } from "./types.js";

const DEFAULT_BASE_URL = "https://api.chusky.ai";

export class Chusky {
  readonly threads: ThreadsResource;
  readonly tasks: TasksResource;
  readonly approvals: ApprovalsResource;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: ChuskyClientOptions) {
    if (!options.apiKey.trim()) throw new ChuskyError("apiKey is required");
    if (!options.userId.trim()) throw new ChuskyError("userId is required");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? "chusky-typescript/0.1.0";
    this.threads = new ThreadsResource(this);
    this.tasks = new TasksResource(this);
    this.approvals = new ApprovalsResource(this);
  }

  async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ChuskyError("Chusky request timed out")), this.timeoutMs);
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.apiKey}`);
      headers.set("X-Chusky-User-Id", this.userId);
      headers.set("Accept", "application/json");
      headers.set("User-Agent", this.userAgent);
      if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
      for (const [key, value] of new Headers(options.headers)) headers.set(key, value);
      const response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) throw await toError(response);
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }

  /** @internal Shared transport for resource streams. */
  async streamRequest(path: string, init: RequestInit, options: RequestOptions = {}): Promise<{ response: Response; dispose: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ChuskyError("Chusky stream request timed out")), this.timeoutMs);
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.apiKey}`);
      headers.set("X-Chusky-User-Id", this.userId);
      headers.set("Accept", "application/x-ndjson");
      headers.set("User-Agent", this.userAgent);
      headers.set("Content-Type", "application/json");
      if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
      const response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) throw await toError(response);
      return { response, dispose: () => options.signal?.removeEventListener("abort", relayAbort) };
    } catch (error) {
      options.signal?.removeEventListener("abort", relayAbort);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ThreadsResource {
  constructor(private readonly client: Chusky) {}
  create(params: CreateThreadParams = {}, options?: RequestOptions): Promise<Thread> { return this.client.request("/threads", { method: "POST", body: JSON.stringify(params) }, options); }
  get(threadId: string, options?: RequestOptions): Promise<Thread> { return this.client.request(`/threads/${encodeURIComponent(threadId)}`, {}, options); }
  list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Thread>> {
    const query = new URLSearchParams(); if (params.cursor) query.set("cursor", params.cursor); if (params.limit) query.set("limit", String(params.limit));
    return this.client.request(`/threads${query.size ? `?${query}` : ""}`, {}, options);
  }
  runs(threadId: string): RunsResource { return new RunsResource(this.client, threadId); }
}

export class RunsResource {
  constructor(private readonly client: Chusky, private readonly threadId: string) {}
  create(params: CreateRunParams, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs`, { method: "POST", body: JSON.stringify(params) }, options); }
  get(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}`, {}, options); }
  cancel(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" }, options); }
  async *stream(params: Omit<CreateRunParams, "wait">, options: RequestOptions = {}): AsyncIterable<RunStreamEvent> {
    const { response, dispose } = await this.client.streamRequest(
      `/threads/${encodeURIComponent(this.threadId)}/runs/stream`,
      { method: "POST", body: JSON.stringify(params) },
      options,
    );
    try { yield* readNdjson<RunStreamEvent>(response.body); } finally { dispose(); }
  }
}

export class TasksResource {
  constructor(private readonly client: Chusky) {}
  get(taskId: string, options?: RequestOptions): Promise<Task> { return this.client.request(`/tasks/${encodeURIComponent(taskId)}`, {}, options); }
  list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Task>> { const q = new URLSearchParams(); if (params.cursor) q.set("cursor", params.cursor); if (params.limit) q.set("limit", String(params.limit)); return this.client.request(`/tasks${q.size ? `?${q}` : ""}`, {}, options); }
}

export class ApprovalsResource {
  constructor(private readonly client: Chusky) {}
  get(approvalId: string, options?: RequestOptions): Promise<Approval> { return this.client.request(`/approvals/${encodeURIComponent(approvalId)}`, {}, options); }
  decide(approvalId: string, decision: "approve" | "deny", options?: RequestOptions): Promise<Run> { return this.client.request(`/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: JSON.stringify({ decision }) }, options); }
}

async function toError(response: Response): Promise<ChuskyError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const retryAfter = Number(response.headers.get("retry-after") ?? "") || undefined;
  let body: { error?: { message?: string; code?: string } } | undefined;
  try { body = await response.json() as typeof body; } catch { /* non-JSON error response */ }
  const message = body?.error?.message ?? `Chusky API returned HTTP ${response.status}`;
  const details = { status: response.status, code: body?.error?.code, requestId };
  if (response.status === 401 || response.status === 403) return new ChuskyAuthenticationError(message, details);
  if (response.status === 429) return new ChuskyRateLimitError(message, { ...details, retryAfter });
  return new ChuskyError(message, details);
}
