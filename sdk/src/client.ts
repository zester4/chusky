import { ChuskyAuthenticationError, ChuskyError, ChuskyRateLimitError } from "./errors.js";
import { readNdjson } from "./stream.js";
import type { Approval, AuditEvent, ChuskyClientOptions, CreateRunParams, CreateThreadParams, DeveloperProject, FileDownload, FileRecord, FileUpload, Page, RequestOptions, Run, RunEvent, RunStreamEvent, Task, Thread, Usage, Webhook, WebhookDelivery } from "./types.js";

const DEFAULT_BASE_URL = "https://api.chusky.ai";

export class Chusky {
  readonly threads: ThreadsResource;
  readonly tasks: TasksResource;
  readonly approvals: ApprovalsResource;
  readonly files: FilesResource;
  readonly audit: AuditResource;
  readonly webhooks: WebhooksResource;
  readonly usage: UsageResource;
  readonly projects: ProjectsResource;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly model?: string;

  constructor(options: ChuskyClientOptions) {
    if (!options.apiKey.trim()) throw new ChuskyError("apiKey is required");
    if (!options.userId.trim()) throw new ChuskyError("userId is required");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? "chusky-typescript/0.1.0";
    this.model = options.model;
    this.threads = new ThreadsResource(this);
    this.tasks = new TasksResource(this);
    this.approvals = new ApprovalsResource(this);
    this.files = new FilesResource(this);
    this.audit = new AuditResource(this);
    this.webhooks = new WebhooksResource(this);
    this.usage = new UsageResource(this);
    this.projects = new ProjectsResource(this);
  }

  /** @internal Returns the configured default model for run requests. */
  modelForRuns(): { model?: string } { return this.model ? { model: this.model } : {}; }

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
      if (response.status === 204) return undefined as T;
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

/** Trusted-server client for provisioning project keys. */
export function createChuskyAdmin(options: Omit<ChuskyClientOptions, "userId"> & { userId?: string }): Chusky {
  return new Chusky({ ...options, userId: options.userId ?? "operator" });
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
  create(params: CreateRunParams, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs`, { method: "POST", body: JSON.stringify({ ...params, ...(params.model ? {} : this.client.modelForRuns()) }) }, options); }
  get(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}`, {}, options); }
  list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Run>> { const query = new URLSearchParams(); if (params.cursor) query.set("cursor", params.cursor); if (params.limit) query.set("limit", String(params.limit)); return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs${query.size ? `?${query}` : ""}`, {}, options); }
  cancel(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" }, options); }
  events(runId: string, after?: number, options?: RequestOptions): Promise<Page<RunEvent>> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}/events${after ? `?after=${after}` : ""}`, {}, options); }
  async *stream(params: Omit<CreateRunParams, "wait">, options: RequestOptions = {}): AsyncIterable<RunStreamEvent> {
    const { response, dispose } = await this.client.streamRequest(
      `/threads/${encodeURIComponent(this.threadId)}/runs/stream`,
      { method: "POST", body: JSON.stringify({ ...params, ...(params.model ? {} : this.client.modelForRuns()) }) },
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
export class FilesResource {
  constructor(private readonly client: Chusky) {}
  create(params: { name: string; contentType: string; size: number }, options?: RequestOptions): Promise<FileUpload> { return this.client.request("/files", { method: "POST", body: JSON.stringify(params) }, options); }
  complete(fileId: string, options?: RequestOptions): Promise<FileRecord> { return this.client.request(`/files/${encodeURIComponent(fileId)}/complete`, { method: "POST", body: "{}" }, options); }
  get(fileId: string, options?: RequestOptions): Promise<FileDownload> { return this.client.request(`/files/${encodeURIComponent(fileId)}`, {}, options); }
  delete(fileId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, options); }
}
export class AuditResource {
  constructor(private readonly client: Chusky) {}
  list(after?: number, options?: RequestOptions): Promise<Page<AuditEvent>> { return this.client.request(`/audit-events${after ? `?after=${after}` : ""}`, {}, options); }
}
export class WebhooksResource {
  constructor(private readonly client: Chusky) {}
  create(url: string, options?: RequestOptions): Promise<Webhook> { return this.client.request("/webhooks", { method: "POST", body: JSON.stringify({ url }) }, options); }
  list(options?: RequestOptions): Promise<Page<Webhook>> { return this.client.request("/webhooks", {}, options); }
  deliveries(webhookId: string, options?: RequestOptions): Promise<Page<WebhookDelivery>> { return this.client.request(`/webhooks/${encodeURIComponent(webhookId)}/deliveries`, {}, options); }
  delete(webhookId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" }, options); }
}
export class UsageResource {
  constructor(private readonly client: Chusky) {}
  get(options?: RequestOptions): Promise<Usage> { return this.client.request("/usage", {}, options); }
}
/** Root-key-only control plane for provisioning developer projects. */
export class ProjectsResource {
  constructor(private readonly client: Chusky) {}
  create(params: { name: string; scopes?: string[] }, options?: RequestOptions): Promise<DeveloperProject> { return this.client.request("/admin/projects", { method: "POST", body: JSON.stringify(params) }, options); }
  list(options?: RequestOptions): Promise<Page<DeveloperProject>> { return this.client.request("/admin/projects", {}, options); }
  audit(after?: number, options?: RequestOptions): Promise<Page<AuditEvent>> { return this.client.request(`/admin/audit-events${after ? `?after=${after}` : ""}`, {}, options); }
  updateScopes(projectId: string, scopes: string[], options?: RequestOptions): Promise<DeveloperProject> { return this.client.request(`/admin/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify({ scopes }) }, options); }
  rotateKey(projectId: string, options?: RequestOptions): Promise<DeveloperProject> { return this.client.request(`/admin/projects/${encodeURIComponent(projectId)}/rotate-key`, { method: "POST", body: "{}" }, options); }
  revoke(projectId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/admin/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }, options); }
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
