export type JsonObject = Record<string, unknown>;

export interface RequestOptions {
  /** Cancels this request without cancelling other Chusky work. */
  signal?: AbortSignal | null;
  /** Required for POST operations that create or change durable state. */
  idempotencyKey?: string;
  /** Additional headers, useful for tracing or a staged API version. */
  headers?: HeadersInit;
}

export interface Page<T> {
  data: T[];
  nextCursor?: string;
}
export interface FileUpload { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; uploadUrl: string; expiresAt: string; }
export interface FileDownload { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; downloadUrl: string; expiresAt: string; }
export interface FileRecord { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; }
export interface AuditEvent { id: string; action: string; requestId: string; status: number; at: number; }
export interface Webhook { id: string; url: string; createdAt: string; secret?: string; }
export interface WebhookDelivery { id: string; status: "queued" | "delivering" | "delivered" | "failed"; attempts: number; lastError?: string; createdAt: string; deliveredAt?: string; }
export interface DeveloperProject { id: string; name: string; keyPrefix: string; scopes: string[]; createdAt: string; revokedAt?: string; key?: string; }
export interface Usage { messages: number; cost: number; files: { count: number; declaredBytes: number; available: number }; runs: { count: number; active: number }; tasks: { count: number }; }

export interface Thread {
  id: string;
  externalId?: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadParams {
  externalId?: string;
  metadata?: JsonObject;
}

export interface Run {
  id: string;
  threadId: string;
  status: "queued" | "running" | "requires_approval" | "completed" | "failed" | "cancelled";
  input: string;
  model?: string;
  output?: string;
  taskId?: string;
  approvalId?: string;
  metadata?: JsonObject;
  budget?: RunBudget;
  tools?: RunToolPolicy;
  skills?: string[];
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunParams {
  input: string;
  /** Optional model override. The server validates it against available models. */
  model?: string;
  metadata?: JsonObject;
  attachments?: string[];
  budget?: RunBudget;
  tools?: RunToolPolicy;
  skills?: string[];
  /** Wait for a terminal result. Use stream() for token-level progress. */
  wait?: boolean;
}

export type DurationBudget = "5m" | "30m" | "1h" | "3h" | "6h" | "3d" | "1w";
export interface RunBudget { duration?: DurationBudget; maxToolCalls?: number; maxCost?: number; }
export interface RunToolPolicy { allow?: string[]; deny?: string[]; requireApproval?: string[]; }

export interface Task {
  id: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  title: string;
  objective: string;
  checkpoint?: string;
  nextAction?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  attempt?: number;
  maxAttempts?: number;
  events?: Array<{ id: string; type: string; message: string; at: number; attempt: number }>;
}

export interface Approval {
  id: string;
  status: "pending" | "approved" | "denied" | "consumed";
  toolSlug: string;
  args: JsonObject;
  expiresAt: string;
  request?: string;
  channelProvider?: string;
  handoffId?: string;
}

export interface Skill { name: string; description: string; path: string; bytes?: number; updatedAt?: string; files?: number; }
export interface SkillFile { name?: string; path: string; bytes: number; binary: boolean; content?: string; truncated?: boolean; }
export interface Tool { slug: string; description: string; source: "native" | "composio"; approval?: "auto" | "approval_required"; toolkit?: string; connected?: boolean; }
export interface Artifact { id: string; name: string; type: "website" | "report" | "docx" | "presentation" | "pdf" | "spreadsheet" | "image" | "video" | "zip" | "project"; path: string; contentType: string; size: number; status: "available"; sandboxId: string; createdAt: string; updatedAt: string; downloadUrl?: string; }
export interface VideoJob { id: string; prompt: string; destination: "telegram" | "daytona" | "both"; workspacePath?: string; workflowRunId?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; pollCount: number; error?: string; resultPath?: string; createdAt: string; updatedAt: string; completedAt?: string; }
export interface Worker { id: string; worker: string; from: string; objective: string; expectedOutput: string; status: string; taskId?: string; workflowRunId?: string; timestamp: string; delegation?: JsonObject; context?: JsonObject; }
export interface ChannelConnection { provider: string; externalUserId: string; workspaceId?: string; displayName?: string; verifiedAt: string; proactiveOptIn: boolean; }
export interface Activity { now: number; approvals: Approval[]; tasks: Task[]; reminders: JsonObject[]; jobs: JsonObject[]; }
export interface Delivery { id: string; provider: string; status: string; kind: string; attempts: number; providerStatus?: string; lastError?: string; createdAt: string; updatedAt: string; deliveredAt?: string; }

export type RunStreamEvent =
  | { type: "run.queued"; run: Run }
  | { type: "run.started"; run: Run }
  | { type: "run.delta"; runId: string; text: string }
  | { type: "run.tool_started"; runId: string; toolSlug: string }
  | { type: "run.approval_required"; run: Run; approval: Approval }
  | { type: "run.completed"; run: Run }
  | { type: "run.failed"; run: Run; error: { code: string; message: string } }
  | { type: "run.cancelled"; run: Run };

export interface RunEvent { id: string; type: string; at: number; text?: string; }

export interface ChuskyClientOptions {
  apiKey: string;
  /** Stable developer-owned identifier for the end user whose Chusky state is used. */
  userId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Default model for runs created by this client. A run-level model overrides it. */
  model?: string;
}
