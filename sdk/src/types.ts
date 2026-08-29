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
  output?: string;
  taskId?: string;
  approvalId?: string;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunParams {
  input: string;
  metadata?: JsonObject;
  /** Wait for a terminal result. Use stream() for token-level progress. */
  wait?: boolean;
}

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
}

export interface Approval {
  id: string;
  status: "pending" | "approved" | "denied" | "consumed";
  toolSlug: string;
  args: JsonObject;
  expiresAt: string;
}

export type RunStreamEvent =
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
}
