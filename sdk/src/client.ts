import { ChuskyAuthenticationError, ChuskyError, ChuskyRateLimitError } from "./errors.js";
import { readNdjson } from "./stream.js";
import type { AccountPreferences, Activity, AppConnection, Approval, ApprovalDecision, Artifact, AuditEvent, CallApproval, CallsResponse, ChannelConnection, ChuskyClientOptions, CliDevice, CompanyAgent, CompanyAgentCreateParams, CompanyAgentTemplate, CompanyAuditEvent, CompanyBranding, CompanyRunSummary, CompanyUsage, CreateRunParams, CreateThreadParams, DeveloperProject, Delivery, FileDownload, FileRecord, FileUpload, JoinMeetingParams, LinkableChannelProvider, LiveVoicePreference, MeetingBrief, MeetingContext, MeetingProfile, MeetingRecord, MeetingsResponse, MemoryFact, Page, RecurringJob, Reminder, RequestOptions, Run, RunEvent, RunStreamEvent, ScratchpadEntry, Skill, SkillFile, Task, Thread, Tool, Usage, VideoJob, VoiceCallProfile, VoiceOptions, Webhook, WebhookDelivery, Worker } from "./types.js";

const DEFAULT_BASE_URL = "https://api.chusky.ai";

export class Chusky {
  readonly threads: ThreadsResource;
  readonly runs: CompanyRunsResource;
  readonly company: CompanyResource;
  readonly agents: AgentsResource;
  readonly tasks: TasksResource;
  readonly approvals: ApprovalsResource;
  readonly files: FilesResource;
  readonly audit: AuditResource;
  readonly webhooks: WebhooksResource;
  readonly usage: UsageResource;
  readonly projects: ProjectsResource;
  readonly tools: ToolsResource;
  readonly skills: SkillsResource;
  readonly artifacts: ArtifactsResource;
  readonly videos: VideosResource;
  readonly workers: WorkersResource;
  readonly channels: ChannelsResource;
  readonly activity: ActivityResource;
  readonly account: AccountResource;
  readonly calls: CallsResource;
  readonly meetings: MeetingsResource;
  readonly apps: AppsResource;
  readonly reminders: RemindersResource;
  readonly jobs: JobsResource;
  readonly memory: MemoryResource;
  readonly scratchpad: ScratchpadResource;
  readonly devices: DevicesResource;
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
    this.userAgent = options.userAgent ?? "chusky-typescript";
    this.model = options.model;
    this.threads = new ThreadsResource(this);
    this.runs = new CompanyRunsResource(this);
    this.company = new CompanyResource(this);
    this.agents = new AgentsResource(this);
    this.tasks = new TasksResource(this);
    this.approvals = new ApprovalsResource(this);
    this.files = new FilesResource(this);
    this.audit = new AuditResource(this);
    this.webhooks = new WebhooksResource(this);
    this.usage = new UsageResource(this);
    this.projects = new ProjectsResource(this);
    this.tools = new ToolsResource(this);
    this.skills = new SkillsResource(this);
    this.artifacts = new ArtifactsResource(this);
    this.videos = new VideosResource(this);
    this.workers = new WorkersResource(this);
    this.channels = new ChannelsResource(this);
    this.activity = new ActivityResource(this);
    this.account = new AccountResource(this);
    this.calls = new CallsResource(this);
    this.meetings = new MeetingsResource(this);
    this.apps = new AppsResource(this);
    this.reminders = new RemindersResource(this);
    this.jobs = new JobsResource(this);
    this.memory = new MemoryResource(this);
    this.scratchpad = new ScratchpadResource(this);
    this.devices = new DevicesResource(this);
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

  /** @internal Binary transport used for artifact and file downloads. */
  async requestBytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ChuskyError("Chusky request timed out")), this.timeoutMs);
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const headers = new Headers(options.headers);
      headers.set("Authorization", `Bearer ${this.apiKey}`); headers.set("X-Chusky-User-Id", this.userId); headers.set("Accept", "application/octet-stream"); headers.set("User-Agent", this.userAgent);
      const response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { headers, signal: controller.signal });
      if (!response.ok) throw await toError(response);
      return new Uint8Array(await response.arrayBuffer());
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", relayAbort); }
  }

  /** @internal Upload bytes to a presigned storage URL using the configured fetch implementation. */
  async uploadBytes(url: string, data: Uint8Array, contentType: string): Promise<Response> {
    // Uint8Array is a standards-based BodyInit in browsers, workers, and
    // Node's fetch. Buffer would make this otherwise portable SDK Node-only.
    return this.fetchImpl(url, { method: "PUT", body: data as BodyInit, headers: { "Content-Type": contentType } });
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
  list(params: { cursor?: string; limit?: number; includeArchived?: boolean } = {}, options?: RequestOptions): Promise<Page<Thread>> {
    const query = new URLSearchParams(); if (params.cursor) query.set("cursor", params.cursor); if (params.limit) query.set("limit", String(params.limit)); if (params.includeArchived) query.set("includeArchived", "true");
    return this.client.request(`/threads${query.size ? `?${query}` : ""}`, {}, options);
  }
  runs(threadId: string): RunsResource { return new RunsResource(this.client, threadId); }
  update(threadId: string, params: { title?: string; archived?: boolean }, options?: RequestOptions): Promise<Thread> { return this.client.request(`/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify(params) }, options); }
  delete(threadId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }, options); }
}

export class RunsResource {
  constructor(private readonly client: Chusky, private readonly threadId: string) {}
  create(params: CreateRunParams, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs`, { method: "POST", body: JSON.stringify({ ...params, ...(params.model ? {} : this.client.modelForRuns()) }) }, options); }
  get(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}`, {}, options); }
  list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Run>> { const query = new URLSearchParams(); if (params.cursor) query.set("cursor", params.cursor); if (params.limit) query.set("limit", String(params.limit)); return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs${query.size ? `?${query}` : ""}`, {}, options); }
  cancel(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" }, options); }
  resume(runId: string, options?: RequestOptions): Promise<Run> { return this.client.request(`/threads/${encodeURIComponent(this.threadId)}/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body: "{}" }, options); }
  async wait(runId: string, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal | null } = {}): Promise<Run> {
    const deadline = Date.now() + (options.timeoutMs ?? 300_000); const interval = Math.max(250, options.intervalMs ?? 1_000);
    while (true) { const run = await this.get(runId, { signal: options.signal }); if (!["queued", "running"].includes(run.status)) return run; if (Date.now() >= deadline) throw new ChuskyError("Timed out waiting for run", { code: "wait_timeout" }); await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, interval); options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason ?? new ChuskyError("Wait cancelled")); }, { once: true }); }); }
  }
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

/** Cross-thread convenience API for durable, template-governed company runs. */
export class CompanyRunsResource {
  constructor(private readonly client: Chusky) {}
  async create(params: CreateRunParams, options?: RequestOptions): Promise<{ thread: Thread; run: Run }> {
    const key = options?.idempotencyKey;
    const thread = await this.client.threads.create({ metadata: { source: "chusky-sdk" } }, {
      ...options,
      ...(key ? { idempotencyKey: `${key}:thread`.slice(0, 255) } : {}),
    });
    const run = await this.client.threads.runs(thread.id).create({
      ...params,
      ...(params.model ? {} : this.client.modelForRuns()),
      wait: params.wait ?? false,
    }, {
      ...options,
      ...(key ? { idempotencyKey: `${key}:run`.slice(0, 255) } : {}),
    });
    return { thread, run };
  }
  get(threadId: string, runId: string, options?: RequestOptions): Promise<Run> { return this.client.threads.runs(threadId).get(runId, options); }
  list(threadId: string, params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Run>> { return this.client.threads.runs(threadId).list(params, options); }
  cancel(threadId: string, runId: string, options?: RequestOptions): Promise<Run> { return this.client.threads.runs(threadId).cancel(runId, options); }
  resume(threadId: string, runId: string, options?: RequestOptions): Promise<Run> { return this.client.threads.runs(threadId).resume(runId, options); }
  events(threadId: string, runId: string, after?: number, options?: RequestOptions): Promise<Page<RunEvent>> { return this.client.threads.runs(threadId).events(runId, after, options); }
  wait(threadId: string, runId: string, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal | null } = {}): Promise<Run> { return this.client.threads.runs(threadId).wait(runId, options); }
}

/** Project-scoped, cross-caller company telemetry. Requires the `company:read` scope. */
export class CompanyResource {
  constructor(private readonly client: Chusky) {}
  runs(params: { limit?: number } = {}, options?: RequestOptions): Promise<Page<CompanyRunSummary>> {
    const query = new URLSearchParams(); if (params.limit) query.set("limit", String(params.limit));
    return this.client.request(`/company/runs${query.size ? `?${query}` : ""}`, {}, options);
  }
  audit(params: { after?: number } = {}, options?: RequestOptions): Promise<Page<CompanyAuditEvent>> {
    const query = new URLSearchParams(); if (params.after) query.set("after", String(params.after));
    return this.client.request(`/company/audit-events${query.size ? `?${query}` : ""}`, {}, options);
  }
  usage(options?: RequestOptions): Promise<CompanyUsage> { return this.client.request("/company/usage", {}, options); }
}

export class AgentsResource {
  constructor(private readonly client: Chusky) {}
  templates(options?: RequestOptions): Promise<Page<CompanyAgentTemplate>> { return this.client.request("/agents/templates", {}, options); }
  list(options?: RequestOptions): Promise<Page<CompanyAgent>> { return this.client.request("/agents", {}, options); }
  create(params: CompanyAgentCreateParams, options?: RequestOptions): Promise<CompanyAgent> { return this.client.request("/agents", { method: "POST", body: JSON.stringify(params) }, options); }
  get(agentId: string, options?: RequestOptions): Promise<CompanyAgent> { return this.client.request(`/agents/${encodeURIComponent(agentId)}`, {}, options); }
  update(agentId: string, params: Partial<CompanyAgentCreateParams>, options?: RequestOptions): Promise<CompanyAgent> { return this.client.request(`/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(params) }, options); }
  delete(agentId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }, options); }
}

export class TasksResource {
  constructor(private readonly client: Chusky) {}
  get(taskId: string, options?: RequestOptions): Promise<Task> { return this.client.request(`/tasks/${encodeURIComponent(taskId)}`, {}, options); }
  list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Task>> { const q = new URLSearchParams(); if (params.cursor) q.set("cursor", params.cursor); if (params.limit) q.set("limit", String(params.limit)); return this.client.request(`/tasks${q.size ? `?${q}` : ""}`, {}, options); }
  retry(taskId: string, options?: RequestOptions): Promise<Task> { return this.client.request(`/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" }, options); }
  cancel(taskId: string, options?: RequestOptions): Promise<Task> { return this.client.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" }, options); }
}

export class ApprovalsResource {
  constructor(private readonly client: Chusky) {}
  get(approvalId: string, options?: RequestOptions): Promise<Approval> { return this.client.request(`/approvals/${encodeURIComponent(approvalId)}`, {}, options); }
  decide(approvalId: string, decision: "approve" | "deny", options?: RequestOptions): Promise<Run | ApprovalDecision> { return this.client.request(`/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: JSON.stringify({ decision }) }, options); }
  list(options?: RequestOptions): Promise<Page<Approval>> { return this.client.request("/approvals", {}, options); }
}
export class FilesResource {
  constructor(private readonly client: Chusky) {}
  create(params: { name: string; contentType: string; size: number }, options?: RequestOptions): Promise<FileUpload> { return this.client.request("/files", { method: "POST", body: JSON.stringify(params) }, options); }
  complete(fileId: string, options?: RequestOptions): Promise<FileRecord> { return this.client.request(`/files/${encodeURIComponent(fileId)}/complete`, { method: "POST", body: "{}" }, options); }
  get(fileId: string, options?: RequestOptions): Promise<FileDownload> { return this.client.request(`/files/${encodeURIComponent(fileId)}`, {}, options); }
  delete(fileId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, options); }
  async upload(input: { name: string; contentType: string; data: Uint8Array | ArrayBuffer }, options?: RequestOptions): Promise<FileRecord> {
    const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const intent = await this.create({ name: input.name, contentType: input.contentType, size: data.byteLength }, options);
    const response = await this.client.uploadBytes(intent.uploadUrl, data, input.contentType);
    if (!response.ok) throw new ChuskyError(`Upload failed with HTTP ${response.status}`, { code: "upload_failed", status: response.status });
    return this.complete(intent.id, options?.idempotencyKey ? { ...options, idempotencyKey: `${options.idempotencyKey}:complete` } : options);
  }
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
  setEnabled(webhookId: string, enabled: boolean, options?: RequestOptions): Promise<Webhook> { return this.client.request(`/webhooks/${encodeURIComponent(webhookId)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }, options); }
  retryDelivery(webhookId: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery> { return this.client.request(`/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST", body: "{}" }, options); }
  delete(webhookId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" }, options); }
}

export class ToolsResource {
  constructor(private readonly client: Chusky) {}
  list(params: { query?: string; source?: "native" | "composio"; toolkit?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Tool>> { const q = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value)); return this.client.request(`/tools${q.size ? `?${q}` : ""}`, {}, options); }
  get(slug: string, options?: RequestOptions): Promise<Tool> { return this.client.request(`/tools/${encodeURIComponent(slug)}`, {}, options); }
}
export class SkillsResource {
  constructor(private readonly client: Chusky) {}
  list(params: { query?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Skill>> { const q = new URLSearchParams(); if (params.query) q.set("query", params.query); if (params.limit) q.set("limit", String(params.limit)); return this.client.request(`/skills${q.size ? `?${q}` : ""}`, {}, options); }
  files(name: string, maxFiles?: number, options?: RequestOptions): Promise<Page<SkillFile>> { const q = maxFiles ? `?maxFiles=${encodeURIComponent(String(maxFiles))}` : ""; return this.client.request(`/skills/${encodeURIComponent(name)}/files${q}`, {}, options); }
  read(name: string, path = "SKILL.md", maxChars?: number, options?: RequestOptions): Promise<SkillFile> { const q = new URLSearchParams({ path }); if (maxChars) q.set("maxChars", String(maxChars)); return this.client.request(`/skills/${encodeURIComponent(name)}/files/read?${q}`, {}, options); }
}
export class ArtifactsResource {
  constructor(private readonly client: Chusky) {}
  list(params: { type?: string; limit?: number } = {}, options?: RequestOptions): Promise<Page<Artifact>> { const q = new URLSearchParams(); if (params.type) q.set("type", params.type); if (params.limit) q.set("limit", String(params.limit)); return this.client.request(`/artifacts${q.size ? `?${q}` : ""}`, {}, options); }
  get(id: string, options?: RequestOptions): Promise<Artifact> { return this.client.request(`/artifacts/${encodeURIComponent(id)}`, {}, options); }
  download(id: string, options?: RequestOptions): Promise<Uint8Array> { return this.client.requestBytes(`/artifacts/${encodeURIComponent(id)}/download`, options); }
  delete(id: string, options?: RequestOptions): Promise<void> { return this.client.request(`/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }, options); }
}
export class VideosResource {
  constructor(private readonly client: Chusky) {}
  create(params: { prompt: string; destination?: "telegram" | "daytona" | "both"; workspacePath?: string; duration?: number; aspectRatio?: string; resolution?: string; generateAudio?: boolean }, options?: RequestOptions): Promise<VideoJob> { return this.client.request("/videos", { method: "POST", body: JSON.stringify(params) }, options); }
  list(options?: RequestOptions): Promise<Page<VideoJob>> { return this.client.request("/videos", {}, options); }
  get(id: string, options?: RequestOptions): Promise<VideoJob> { return this.client.request(`/videos/${encodeURIComponent(id)}`, {}, options); }
  cancel(id: string, options?: RequestOptions): Promise<VideoJob> { return this.client.request(`/videos/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }, options); }
  async wait(id: string, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal | null } = {}): Promise<VideoJob> { const deadline = Date.now() + (options.timeoutMs ?? 600_000); while (true) { const job = await this.get(id, { signal: options.signal }); if (!["queued", "running"].includes(job.status)) return job; if (Date.now() >= deadline) throw new ChuskyError("Timed out waiting for video job", { code: "wait_timeout" }); await new Promise((resolve) => setTimeout(resolve, Math.max(500, options.intervalMs ?? 2_000))); } }
}
export class WorkersResource {
  constructor(private readonly client: Chusky) {}
  create(params: { worker: string; objective: string; expectedOutput?: string; model?: string; allowedTools?: string[]; allowedComposioTools?: string[]; duration?: import("./types.js").DurationBudget; timeoutSeconds?: number; maxToolCalls?: number }, options?: RequestOptions): Promise<Worker> { return this.client.request("/workers", { method: "POST", body: JSON.stringify(params) }, options); }
  list(params: { limit?: number; status?: string } = {}, options?: RequestOptions): Promise<Page<Worker>> { const q = new URLSearchParams(); if (params.limit) q.set("limit", String(params.limit)); if (params.status) q.set("status", params.status); return this.client.request(`/workers${q.size ? `?${q}` : ""}`, {}, options); }
  get(id: string, options?: RequestOptions): Promise<Worker> { return this.client.request(`/workers/${encodeURIComponent(id)}`, {}, options); }
  cancel(id: string, reason?: string, options?: RequestOptions): Promise<Worker> { return this.client.request(`/workers/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }, options); }
}
export class ChannelsResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<Page<ChannelConnection>> { return this.client.request("/channels", {}, options); }
  linkCode(provider: LinkableChannelProvider, options?: RequestOptions): Promise<{ provider: string; code: string; expiresInSeconds: number; instructions: string; installUrl?: string }> { return this.client.request("/channels/link-code", { method: "POST", body: JSON.stringify({ provider }) }, options); }
  setProactive(provider: string, identityId: string, proactiveOptIn: boolean, options?: RequestOptions): Promise<ChannelConnection> { return this.client.request(`/channels/${encodeURIComponent(provider)}/${encodeURIComponent(identityId)}`, { method: "PATCH", body: JSON.stringify({ proactiveOptIn }) }, options); }
  unlink(provider: string, identityId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/channels/${encodeURIComponent(provider)}/${encodeURIComponent(identityId)}`, { method: "DELETE" }, options); }
}
export class ActivityResource {
  constructor(private readonly client: Chusky) {}
  get(since?: number, options?: RequestOptions): Promise<Activity> { return this.client.request(`/activity${since ? `?since=${since}` : ""}`, {}, options); }
  deliveries(options?: RequestOptions): Promise<Page<Delivery>> { return this.client.request("/deliveries", {}, options); }
}

export class AccountResource {
  constructor(private readonly client: Chusky) {}
  overview(options?: RequestOptions): Promise<Record<string, unknown>> { return this.client.request("/account/overview", {}, options); }
  models(options?: RequestOptions): Promise<Page<Record<string, unknown>>> { return this.client.request("/account/models", {}, options); }
  organizationBranding(organizationId: string, options?: RequestOptions): Promise<{ data: CompanyBranding | null }> { return this.client.request(`/account/organizations/${encodeURIComponent(organizationId)}/branding`, {}, options); }
  updateOrganizationBranding(organizationId: string, branding: Omit<CompanyBranding, "organizationId" | "updatedAt" | "customDomainStatus">, options?: RequestOptions): Promise<{ data: CompanyBranding }> { return this.client.request(`/account/organizations/${encodeURIComponent(organizationId)}/branding`, { method: "PUT", body: JSON.stringify(branding) }, options); }
  preferences(params: { model?: string; voiceReplies?: boolean; liveVoice?: LiveVoicePreference }, options?: RequestOptions): Promise<AccountPreferences> { return this.client.request("/account/preferences", { method: "PATCH", body: JSON.stringify(params) }, options); }
  getPreferences(options?: RequestOptions): Promise<AccountPreferences> { return this.client.request("/account/preferences", {}, options); }
  voiceOptions(options?: RequestOptions): Promise<VoiceOptions> { return this.client.request("/account/voice-options", {}, options); }
  apps(options?: RequestOptions): Promise<Page<Record<string, unknown>>> { return this.client.request("/apps", {}, options); }
  connectApp(toolkit: string, options?: RequestOptions): Promise<{ toolkit: string; url: string }> { return this.client.request(`/apps/${encodeURIComponent(toolkit)}/connect`, { method: "POST", body: "{}" }, options); }
  appConnections(options?: RequestOptions): Promise<Page<AppConnection>> { return this.client.request("/apps/connections", {}, options); }
  disconnectApp(connectionId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/apps/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" }, options); }
  triggers(options?: RequestOptions): Promise<Page<Record<string, unknown>>> { return this.client.request("/triggers", {}, options); }
  triggerToolkits(params: { connectedOnly?: boolean } = {}, options?: RequestOptions): Promise<Page<Record<string, unknown>>> {
    const query = params.connectedOnly === false ? "?connectedOnly=false" : "";
    return this.client.request(`/triggers/catalog/toolkits${query}`, {}, options);
  }
  triggerTypes(toolkit: string, params: { page?: number; pageSize?: number } = {}, options?: RequestOptions): Promise<Page<Record<string, unknown>>> {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    return this.client.request(`/triggers/catalog/toolkits/${encodeURIComponent(toolkit)}${query.size ? `?${query}` : ""}`, {}, options);
  }
  createTrigger(params: { slug: string; connectedAccountId?: string; triggerConfig?: Record<string, unknown> }, options?: RequestOptions): Promise<Record<string, unknown>> { return this.client.request("/triggers", { method: "POST", body: JSON.stringify(params) }, options); }
  setTriggerState(triggerId: string, enabled: boolean, options?: RequestOptions): Promise<Record<string, unknown>> { return this.client.request(`/triggers/${encodeURIComponent(triggerId)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }, options); }
  deleteTrigger(triggerId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" }, options); }
  telegramLink(options?: RequestOptions): Promise<{ code: string; expiresAt: string }> { return this.client.request("/account/telegram-link", { method: "POST", body: "{}" }, options); }
  calls(options?: RequestOptions): Promise<CallsResponse> { return this.client.request("/account/calls", {}, options); }
}

export class AppsResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<Page<Record<string, unknown>>> { return this.client.request("/apps", {}, options); }
  connect(toolkit: string, alias?: string, options?: RequestOptions): Promise<{ toolkit: string; alias?: string; url: string }> { return this.client.request(`/apps/${encodeURIComponent(toolkit)}/connect`, { method: "POST", body: JSON.stringify(alias === undefined ? {} : { alias }) }, options); }
  connections(options?: RequestOptions): Promise<Page<AppConnection>> { return this.client.request("/apps/connections", {}, options); }
  disconnect(connectionId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/apps/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" }, options); }
}

export class RemindersResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<Page<Reminder>> { return this.client.request("/reminders", {}, options); }
  create(params: { text: string; delaySeconds?: number; runAt?: string }, options?: RequestOptions): Promise<Reminder> { return this.client.request("/reminders", { method: "POST", body: JSON.stringify(params) }, options); }
  delete(id: string, options?: RequestOptions): Promise<void> { return this.client.request(`/reminders/${encodeURIComponent(id)}`, { method: "DELETE" }, options); }
}

export class JobsResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<Page<RecurringJob>> { return this.client.request("/jobs", {}, options); }
  create(params: { text: string; cron: string }, options?: RequestOptions): Promise<RecurringJob> { return this.client.request("/jobs", { method: "POST", body: JSON.stringify(params) }, options); }
  delete(id: string, options?: RequestOptions): Promise<void> { return this.client.request(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }, options); }
}

export class MemoryResource {
  constructor(private readonly client: Chusky) {}
  list(query?: string, options?: RequestOptions): Promise<Page<MemoryFact>> { const suffix = query ? `?query=${encodeURIComponent(query)}` : ""; return this.client.request(`/memory${suffix}`, {}, options); }
  save(params: Omit<MemoryFact, "id" | "createdAt" | "updatedAt" | "status" | "expiresAt" | "reviewAt">, options?: RequestOptions): Promise<MemoryFact> { return this.client.request("/memory", { method: "POST", body: JSON.stringify(params) }, options); }
  delete(id: string, options?: RequestOptions): Promise<void> { return this.client.request(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }, options); }
}

export class ScratchpadResource {
  constructor(private readonly client: Chusky) {}
  list(query?: string, options?: RequestOptions): Promise<Page<ScratchpadEntry>> { const suffix = query ? `?query=${encodeURIComponent(query)}` : ""; return this.client.request(`/scratchpad${suffix}`, {}, options); }
  write(key: string, content: string, options?: RequestOptions): Promise<ScratchpadEntry> { return this.client.request(`/scratchpad/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ content }) }, options); }
  clear(key?: string, options?: RequestOptions): Promise<void> { const suffix = key ? `?key=${encodeURIComponent(key)}` : ""; return this.client.request(`/scratchpad${suffix}`, { method: "DELETE" }, options); }
  delete(key: string, options?: RequestOptions): Promise<void> { return this.client.request(`/scratchpad/${encodeURIComponent(key)}`, { method: "DELETE" }, options); }
}

export class DevicesResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<Page<CliDevice>> { return this.client.request("/devices", {}, options); }
  revoke(id: string, options?: RequestOptions): Promise<void> { return this.client.request(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }, options); }
}

export class CallsResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<CallsResponse> { return this.client.request("/account/calls", {}, options); }
  request(params: { phoneNumber: string; purpose: string; profile?: Partial<VoiceCallProfile> }, options?: RequestOptions): Promise<CallApproval> {
    return this.client.request("/account/calls", { method: "POST", body: JSON.stringify(params) }, options);
  }
}

export class MeetingsResource {
  constructor(private readonly client: Chusky) {}
  list(options?: RequestOptions): Promise<MeetingsResponse> { return this.client.request("/meetings", {}, options); }
  get(meetingId: string, options?: RequestOptions): Promise<MeetingRecord> { return this.client.request(`/meetings/${encodeURIComponent(meetingId)}`, {}, options); }
  profile(options?: RequestOptions): Promise<MeetingProfile> { return this.client.request("/meetings/profile", {}, options); }
  updateProfile(profile: Partial<MeetingProfile>, options?: RequestOptions): Promise<MeetingProfile> { return this.client.request("/meetings/profile", { method: "PATCH", body: JSON.stringify(profile) }, options); }
  prepare(brief: MeetingBrief, options?: RequestOptions): Promise<Record<string, unknown>> { return this.client.request("/meetings/prepare", { method: "POST", body: JSON.stringify(brief) }, options); }
  join(params: JoinMeetingParams, options?: RequestOptions): Promise<MeetingRecord> { return this.client.request("/meetings", { method: "POST", body: JSON.stringify(params) }, options); }
  joinPreparation(preparationId: string, options?: RequestOptions): Promise<MeetingRecord & { preparation?: Record<string, unknown> }> { return this.client.request(`/meetings/preparations/${encodeURIComponent(preparationId)}/join`, { method: "POST", body: "{}" }, options); }
  leave(meetingId: string, options?: RequestOptions): Promise<MeetingRecord & { alreadyFinished?: boolean }> { return this.client.request(`/meetings/${encodeURIComponent(meetingId)}/leave`, { method: "POST", body: "{}" }, options); }
  context(meetingId: string, query = "", options?: RequestOptions): Promise<MeetingContext> { const suffix = query ? `?query=${encodeURIComponent(query)}` : ""; return this.client.request(`/meetings/${encodeURIComponent(meetingId)}/context${suffix}`, {}, options); }
  deleteContact(contactId: string, options?: RequestOptions): Promise<void> { return this.client.request(`/meetings/contacts/${encodeURIComponent(contactId)}`, { method: "DELETE" }, options); }
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
