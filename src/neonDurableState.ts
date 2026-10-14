import type { QueryResultRow } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { REDIS_METRIC_FAMILIES, type RedisCommandFamilyMetrics, type RedisMetricFamily } from "./redisMetrics.js";

export const DURABLE_SESSION_DOMAINS = ["profile", "conversation", "memories", "assets", "sdk"] as const;
export type DurableSessionDomain = typeof DURABLE_SESSION_DOMAINS[number];

export interface DurableSessionDocument {
  domain: DurableSessionDomain;
  payload: unknown;
  version: number;
  updatedAt: number;
}

/** Safe operational facts for health checks. Payloads and user IDs never leave
 * the repository through this shape. */
export interface DurableStateStatus {
  enabled: boolean;
  reachable: boolean;
  schemaReady: boolean;
}

export interface DurableSdkRun {
  userId: number;
  threadId: string;
  runId: string;
  payload: unknown;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface DurableSdkThread {
  userId: number;
  threadId: string;
  externalId: string;
  metadata: Record<string, unknown>;
  history: unknown[];
  createdAt: number;
  updatedAt: number;
}

export interface DurableSdkAuditEvent {
  userId: number;
  auditId: string;
  action: string;
  requestId: string;
  status: number;
  createdAt: number;
}

export interface DurableSdkIdempotencyRecord {
  userId: number;
  key: string;
  fingerprint: string;
  response: unknown;
  createdAt: number;
}

export interface DurableSdkTableState {
  threads: DurableSdkThread[];
  audit: DurableSdkAuditEvent[];
  idempotency: DurableSdkIdempotencyRecord[];
}

export interface DurableSdkTableChanges {
  threads: readonly DurableSdkThread[];
  deletedThreadIds: readonly string[];
  audit: readonly DurableSdkAuditEvent[];
  idempotency: readonly DurableSdkIdempotencyRecord[];
}

export interface QueryMetricSample {
  queryHash: string;
  queryFamily: string;
  commands: number;
  errors: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  maxValueBytes: number;
}

const queryMetricRoute = new AsyncLocalStorage<string>();

/** Attribute private query/transfer aggregates to a bounded API route label. */
export function withNeonQueryMetricRoute<T>(route: string, work: () => Promise<T>): Promise<T> {
  const bounded = route.replace(/[^A-Za-z0-9_ ./:-]/g, "").slice(0, 120) || "unknown";
  return queryMetricRoute.run(bounded, work);
}

export interface DurableConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sourceId?: string;
}

export interface DurableMissionRecord {
  ownerUserId: number;
  missionId: string;
  status: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface DurableMissionEvent {
  id: string;
  type: string;
  message: string;
  at: number;
  [key: string]: unknown;
}

export type DurableObjectKind = "image" | "file" | "transcript_segment" | "agent_run_archive" | "temporary_media" | "other";
export type DurableObjectStatus = "pending" | "available" | "deleting" | "deleted" | "failed";

/** Metadata only; object bytes and public download URLs never belong in Neon. */
export interface DurableObjectMetadata {
  ownerUserId: number;
  objectId: string;
  kind: DurableObjectKind;
  objectKey: string;
  status: DurableObjectStatus;
  contentType: string;
  sizeBytes: number;
  sha256?: string;
  encryptionVersion?: string;
  retentionExpiresAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface DurableStateMetrics {
  queryCount: number;
  queryErrors: number;
  queryDurationMs: number;
  conversationMessagesRead: number;
  conversationMessagesWritten: number;
  conversationBytesRead: number;
  conversationBytesWritten: number;
  sessionDomainWrites: number;
  sessionDomainBytesRead: number;
  sessionDomainBytesWritten: number;
  largestSessionDomainBytes: number;
}

export interface StorageMetricSample extends RedisCommandFamilyMetrics {
  family: RedisMetricFamily;
}

export type StorageMetricTotals = Record<RedisMetricFamily, RedisCommandFamilyMetrics>;

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface TransactionPool extends Queryable {
  connect(): Promise<TransactionClient>;
  end(): Promise<void>;
}

type SessionRow = { domain: DurableSessionDomain; payload: unknown; version: number; updated_at: Date };
type SdkRunRow = { user_id: string | number; thread_id: string; run_id: string; payload: unknown; created_at: Date; updated_at: Date; version: number };
type SdkThreadRow = { user_id: string | number; thread_id: string; external_id: string; metadata: unknown; history: unknown; created_at: Date; updated_at: Date };
type SdkAuditRow = { user_id: string | number; audit_id: string; action: string; request_id: string; status: number; created_at: Date };
type SdkIdempotencyRow = { user_id: string | number; idempotency_key: string; fingerprint: string; response: unknown; created_at: Date };
type MissionRow = { owner_user_id: string | number; mission_id: string; status: string; idempotency_key: string | null; payload: unknown; version: number; created_at: Date; updated_at: Date };
const MISSION_STATUSES = new Set(["queued", "running", "waiting", "paused", "blocked", "completed", "failed", "cancelled"]);
const REDIS_FAMILY_SET = new Set<string>(REDIS_METRIC_FAMILIES);

/** Telemetry must never be able to change the outcome of a database call. */
function safeJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return 0;
  }
}

const DOMAIN_SET = new Set<string>(DURABLE_SESSION_DOMAINS);

/** Hash only the persisted value; local concurrency metadata is not content. */
export function durableSdkRunHash(payload: unknown): string {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : payload;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    delete (value as Record<string, unknown>).durableVersion;
    delete (value as Record<string, unknown>).durablePayloadHash;
  }
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 0) throw new Error("Durable state requires a non-negative integer user ID.");
}

function assertSdkRunIdentity(threadId: string, runId: string): void {
  if (!/^(?:thr|cli_thread)_[A-Za-z0-9_-]{1,120}$/.test(threadId) || !/^run_[A-Za-z0-9_-]{1,120}$/.test(runId)) {
    throw new Error("Durable SDK run identity is invalid.");
  }
}

function assertSdkThreadIdentity(threadId: string): void {
  if (!/^(?:thr|cli_thread)_[A-Za-z0-9_-]{1,120}$/.test(threadId)) throw new Error("Durable SDK thread identity is invalid.");
}

function validateMissionRecord(record: DurableMissionRecord): void {
  assertUserId(record.ownerUserId);
  if (!/^mis_[A-Za-z0-9_-]{1,160}$/.test(record.missionId) || !MISSION_STATUSES.has(record.status)) throw new Error("Durable mission identity or status is invalid.");
  if (record.idempotencyKey !== undefined && (record.idempotencyKey.length < 1 || record.idempotencyKey.length > 200 || /[\r\n\0]/.test(record.idempotencyKey))) throw new Error("Durable mission idempotency key is invalid.");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)
    || record.payload.id !== record.missionId || record.payload.userId !== record.ownerUserId || record.payload.status !== record.status
    || record.payload.version !== record.version || !Array.isArray(record.payload.steps)) throw new Error("Durable mission payload is invalid.");
  if (!Number.isSafeInteger(record.version) || record.version < 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0
    || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) throw new Error("Durable mission version or timestamps are invalid.");
  if (Buffer.byteLength(JSON.stringify(record.payload), "utf8") > 1_000_000) throw new Error("Durable mission payload exceeds the storage limit.");
}

function validateMissionEvents(events: readonly DurableMissionEvent[]): void {
  if (events.length > 5000) throw new Error("Durable mission event batch exceeds the storage limit.");
  for (const event of events) {
    if (!event || !/^[A-Za-z0-9_-]{1,180}$/.test(event.id) || !/^[a-z][a-z0-9_]{0,63}$/.test(event.type)
      || typeof event.message !== "string" || event.message.length > 2000 || !Number.isSafeInteger(event.at) || event.at < 0
      || Buffer.byteLength(JSON.stringify(event), "utf8") > 16_384) throw new Error("Durable mission event is invalid or too large.");
  }
}

const OBJECT_KINDS = new Set<DurableObjectKind>(["image", "file", "transcript_segment", "agent_run_archive", "temporary_media", "other"]);

function validateObjectMetadata(record: DurableObjectMetadata): void {
  assertUserId(record.ownerUserId);
  if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(record.objectId)) throw new Error("Durable object ID is invalid.");
  if (!OBJECT_KINDS.has(record.kind)) throw new Error("Durable object kind is invalid.");
  if (typeof record.objectKey !== "string" || record.objectKey.length > 512 || record.objectKey.startsWith("/")
    || record.objectKey.split("/").some((part) => !part || part === "." || part === "..")
    || !new RegExp(`(?:^|/)${record.ownerUserId}(?:/|$)`).test(record.objectKey)
    || !/^[A-Za-z0-9_./-]+$/.test(record.objectKey)) throw new Error("Durable object key is invalid or not owner-scoped.");
  if (!(record.status === "pending" || record.status === "available" || record.status === "deleting" || record.status === "deleted" || record.status === "failed")) throw new Error("Durable object status is invalid.");
  if (typeof record.contentType !== "string" || record.contentType.length < 1 || record.contentType.length > 160 || /[\r\n\0]/.test(record.contentType)) throw new Error("Durable object content type is invalid.");
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) throw new Error("Durable object size is invalid.");
  if (record.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Durable object checksum is invalid.");
  if (record.status === "available" && !record.sha256) throw new Error("Available durable objects require a verified SHA-256 checksum.");
  if (record.encryptionVersion !== undefined && (record.encryptionVersion.length > 80 || !/^[A-Za-z0-9._-]+$/.test(record.encryptionVersion))) throw new Error("Durable object encryption version is invalid.");
  if (record.retentionExpiresAt !== undefined && (!Number.isSafeInteger(record.retentionExpiresAt) || record.retentionExpiresAt <= 0)) throw new Error("Durable object expiry is invalid.");
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || !Number.isSafeInteger(record.updatedAt) || record.updatedAt <= 0) throw new Error("Durable object timestamps are invalid.");
  const encodedMetadata = JSON.stringify(record.metadata ?? {});
  if (record.metadata !== undefined && (typeof record.metadata !== "object" || Array.isArray(record.metadata)) || Buffer.byteLength(encodedMetadata, "utf8") > 16_384) throw new Error("Durable object metadata is invalid or too large.");
}

function isOwnerScopedObjectKey(userId: number, objectKey: string): boolean {
  return typeof objectKey === "string" && objectKey.length <= 512 && !objectKey.startsWith("/")
    && objectKey.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
    && new RegExp(`(?:^|/)${userId}(?:/|$)`).test(objectKey)
    && /^[A-Za-z0-9_./-]+$/.test(objectKey);
}

function durableObjectFromRow(row: Record<string, unknown>): DurableObjectMetadata {
  const ownerUserId = Number(row.owner_user_id);
  const asMillis = (value: unknown): number | undefined => value instanceof Date ? value.getTime() : typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : undefined;
  const record: DurableObjectMetadata = {
    ownerUserId,
    objectId: String(row.object_id ?? ""),
    kind: String(row.object_kind ?? "") as DurableObjectKind,
    objectKey: String(row.object_key ?? ""),
    status: String(row.lifecycle_status ?? "") as DurableObjectStatus,
    contentType: String(row.content_type ?? ""),
    sizeBytes: Number(row.size_bytes),
    ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    ...(typeof row.encryption_version === "string" ? { encryptionVersion: row.encryption_version } : {}),
    ...(asMillis(row.retention_expires_at) ? { retentionExpiresAt: asMillis(row.retention_expires_at) } : {}),
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {},
    createdAt: asMillis(row.created_at) ?? 0,
    updatedAt: asMillis(row.updated_at) ?? 0,
  };
  validateObjectMetadata(record);
  return record;
}

function toSdkRun(row: SdkRunRow): DurableSdkRun {
  const userId = Number(row.user_id);
  assertUserId(userId);
  assertSdkRunIdentity(row.thread_id, row.run_id);
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : undefined;
  if (!payload || payload.id !== row.run_id || typeof payload.status !== "string" || !Array.isArray(payload.events)) {
    throw new Error("Durable SDK run record is malformed.");
  }
  return {
    userId,
    threadId: row.thread_id,
    runId: row.run_id,
    payload: { ...payload, durableVersion: Number(row.version), durablePayloadHash: durableSdkRunHash(payload) },
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Date.now(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Date.now(),
    version: Number.isSafeInteger(Number(row.version)) && Number(row.version) > 0 ? Number(row.version) : 1,
  };
}

function millis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function toSdkThread(row: SdkThreadRow): DurableSdkThread {
  return { userId: Number(row.user_id), threadId: row.thread_id, externalId: row.external_id, metadata: asObject(row.metadata), history: asArray(row.history), createdAt: millis(row.created_at), updatedAt: millis(row.updated_at) };
}

function toSdkAudit(row: SdkAuditRow): DurableSdkAuditEvent {
  return { userId: Number(row.user_id), auditId: row.audit_id, action: row.action, requestId: row.request_id, status: Number(row.status), createdAt: millis(row.created_at) };
}

function toSdkIdempotency(row: SdkIdempotencyRow): DurableSdkIdempotencyRecord {
  return { userId: Number(row.user_id), key: row.idempotency_key, fingerprint: row.fingerprint, response: row.response, createdAt: millis(row.created_at) };
}

function assertDomain(domain: string): asserts domain is DurableSessionDomain {
  if (!DOMAIN_SET.has(domain)) throw new Error("Unknown durable session domain.");
}

function toDocument(row: SessionRow): DurableSessionDocument {
  assertDomain(row.domain);
  return {
    domain: row.domain,
    payload: row.payload,
    version: Number.isSafeInteger(row.version) && row.version > 0 ? row.version : 1,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Date.now(),
  };
}

function toDurableMission(row: MissionRow): DurableMissionRecord {
  const ownerUserId = Number(row.owner_user_id);
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : undefined;
  const asMillis = (value: unknown): number => value instanceof Date ? value.getTime() : typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
  if (!payload) throw new Error("Durable mission record is malformed.");
  const record: DurableMissionRecord = {
    ownerUserId,
    missionId: row.mission_id,
    status: row.status,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    payload,
    version: Number(row.version),
    createdAt: asMillis(row.created_at),
    updatedAt: asMillis(row.updated_at),
  };
  validateMissionRecord(record);
  return record;
}

/**
 * Canonical durable documents for high-growth user-session domains. Redis
 * remains responsible for leases, cancellation signals, locks, rate limits,
 * and short-lived workflow coordination.
 */
export class NeonDurableState {
  private readonly metrics: DurableStateMetrics = { queryCount: 0, queryErrors: 0, queryDurationMs: 0, conversationMessagesRead: 0, conversationMessagesWritten: 0, conversationBytesRead: 0, conversationBytesWritten: 0, sessionDomainWrites: 0, sessionDomainBytesRead: 0, sessionDomainBytesWritten: 0, largestSessionDomainBytes: 0 };
  private readonly queryMetricInstanceId = randomUUID();
  private queryMetricBatchId = 0;
  private readonly queryMetrics = new Map<string, QueryMetricSample>();

  constructor(private readonly database: TransactionPool) {}

  private async measuredQuery<Row extends QueryResultRow = QueryResultRow>(queryable: Queryable, text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
    const startedAt = Date.now();
    this.metrics.queryCount += 1;
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    const route = queryMetricRoute.getStore();
    const queryHash = createHash("sha256").update(route ? `${route}\n${normalized}` : normalized).digest("hex");
    const table = normalized.match(/(?:from|into|update|join)\s+([a-z0-9_]+)/)?.[1] ?? "other";
    const queryFamily = `${route ? `route:${route}|` : ""}${table}`.slice(0, 120);
    const requestBytes = safeJsonBytes(values ?? []);
    try {
      const result = await queryable.query<Row>(text, values);
      const responseBytes = safeJsonBytes(result.rows);
      this.recordQueryMetric({ queryHash, queryFamily, commands: 1, errors: 0, requestBytes, responseBytes, durationMs: Math.max(0, Date.now() - startedAt), maxValueBytes: Math.max(requestBytes, responseBytes) });
      return result;
    } catch (error) {
      this.metrics.queryErrors += 1;
      this.recordQueryMetric({ queryHash, queryFamily, commands: 1, errors: 1, requestBytes, responseBytes: 0, durationMs: Math.max(0, Date.now() - startedAt), maxValueBytes: requestBytes });
      throw error;
    } finally {
      this.metrics.queryDurationMs += Math.max(0, Date.now() - startedAt);
    }
  }

  private recordQueryMetric(sample: QueryMetricSample): void {
    if (!this.queryMetrics.has(sample.queryHash) && this.queryMetrics.size >= 999) {
      sample = { ...sample, queryHash: createHash("sha256").update("query-metric-overflow").digest("hex"), queryFamily: "overflow" };
    }
    const prior = this.queryMetrics.get(sample.queryHash);
    if (!prior) {
      this.queryMetrics.set(sample.queryHash, { ...sample });
      return;
    }
    prior.commands += sample.commands;
    prior.errors += sample.errors;
    prior.requestBytes += sample.requestBytes;
    prior.responseBytes += sample.responseBytes;
    prior.durationMs += sample.durationMs;
    prior.maxValueBytes = Math.max(prior.maxValueBytes, sample.maxValueBytes);
  }

  /** Take the process-local query/transfer counters without retaining SQL or payloads. */
  takeQueryMetricSnapshot(): { instanceId: string; batchId: number; observedAt: number; samples: QueryMetricSample[] } | undefined {
    if (!this.queryMetrics.size) return undefined;
    const samples = [...this.queryMetrics.values()].map((sample) => ({ ...sample }));
    this.queryMetrics.clear();
    return { instanceId: this.queryMetricInstanceId, batchId: ++this.queryMetricBatchId, observedAt: Date.now(), samples };
  }

  /** Persist a snapshot and restore it if the metrics table is temporarily unavailable. */
  async flushQueryMetrics(): Promise<void> {
    const batch = this.takeQueryMetricSnapshot();
    if (!batch) return;
    try {
      await this.recordQueryMetricBatch(batch);
    } catch (error) {
      for (const sample of batch.samples) this.recordQueryMetric(sample);
      throw error;
    }
  }

  /** Process-local aggregate only; never includes owner IDs or row contents. */
  getMetrics(): DurableStateMetrics { return { ...this.metrics }; }

  /** Verify database reachability with a lightweight, non-data-bearing query. */
  async healthStatus(): Promise<DurableStateStatus> {
    try {
      await this.measuredQuery(this.database, "SELECT 1");
    } catch {
      return { enabled: true, reachable: false, schemaReady: false };
    }
    try {
      await this.assertSessionSchema();
      return { enabled: true, reachable: true, schemaReady: true };
    } catch {
      return { enabled: true, reachable: true, schemaReady: false };
    }
  }

  /** Insert a pending object record idempotently. Reuse is allowed only for the exact same immutable intent. */
  async createObjectMetadata(record: DurableObjectMetadata): Promise<DurableObjectMetadata> {
    validateObjectMetadata(record);
    if (record.status !== "pending" && record.status !== "available") throw new Error("New durable objects must be pending or already verified available.");
    const inserted = await this.measuredQuery<Record<string, unknown>>(this.database,
      `INSERT INTO chusky_object_metadata
       (owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256, encryption_version, retention_expires_at, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10 / 1000.0) END, $11::jsonb, to_timestamp($12 / 1000.0), to_timestamp($13 / 1000.0))
       ON CONFLICT (owner_user_id, object_id) DO NOTHING
       RETURNING owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256, encryption_version, retention_expires_at, metadata, created_at, updated_at`,
      [record.ownerUserId, record.objectId, record.kind, record.objectKey, record.status, record.contentType, record.sizeBytes, record.sha256 ?? null, record.encryptionVersion ?? null, record.retentionExpiresAt ?? null, JSON.stringify(record.metadata ?? {}), record.createdAt, record.updatedAt],
    );
    if (inserted.rows[0]) return durableObjectFromRow(inserted.rows[0]);
    const existing = await this.getObjectMetadata(record.ownerUserId, record.objectId);
    if (!existing || existing.kind !== record.kind || existing.objectKey !== record.objectKey || existing.contentType !== record.contentType
      || existing.sizeBytes !== record.sizeBytes || existing.retentionExpiresAt !== record.retentionExpiresAt
      || existing.encryptionVersion !== record.encryptionVersion || (record.sha256 !== undefined && existing.sha256 !== record.sha256)
      || JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(record.metadata ?? {})) {
      throw new Error("Durable object ID conflict; reload the existing object before retrying.");
    }
    return existing;
  }

  /** Owner-scoped lookup; callers must authorize against this record before touching R2. */
  async getObjectMetadata(userId: number, objectId: string): Promise<DurableObjectMetadata | undefined> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId)) throw new Error("Durable object ID is invalid.");
    const result = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256, encryption_version, retention_expires_at, metadata, created_at, updated_at
       FROM chusky_object_metadata WHERE owner_user_id = $1 AND object_id = $2`,
      [userId, objectId],
    );
    return result.rows[0] ? durableObjectFromRow(result.rows[0]) : undefined;
  }

  /** Bounded indexed lookup for one owner's immutable encrypted Recall segments. */
  async listRecallTranscriptObjects(userId: number, meetingHash: string, includeUnavailable = false): Promise<DurableObjectMetadata[]> {
    assertUserId(userId);
    if (!/^[a-f0-9]{64}$/.test(meetingHash)) throw new Error("Recall transcript meeting identity is invalid.");
    const result = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256, encryption_version, retention_expires_at, metadata, created_at, updated_at
       FROM chusky_object_metadata
       WHERE owner_user_id = $1 AND object_kind = 'transcript_segment' AND metadata->>'meetingHash' = $2
         AND lifecycle_status ${includeUnavailable ? "IN ('pending','available','deleting','failed')" : "= 'available'"}
       ORDER BY object_id
       LIMIT 8001`,
      [userId, meetingHash],
    );
    return result.rows.map(durableObjectFromRow);
  }

  /** Extend or shorten expiry for one exact owner+meeting scope, never for arbitrary catalog metadata. */
  async updateRecallTranscriptObjectExpiry(userId: number, meetingHash: string, expiresAt: number): Promise<void> {
    assertUserId(userId);
    if (!/^[a-f0-9]{64}$/.test(meetingHash) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      throw new Error("Recall transcript archive expiry is invalid.");
    }
    await this.measuredQuery(this.database,
      `UPDATE chusky_object_metadata
       SET retention_expires_at = to_timestamp($3 / 1000.0), updated_at = now()
       WHERE owner_user_id = $1 AND object_kind = 'transcript_segment' AND metadata->>'meetingHash' = $2
         AND lifecycle_status IN ('pending','available','failed')`,
      [userId, meetingHash, expiresAt],
    );
  }

  async markRecallTranscriptArchiveTruncated(userId: number, meetingHash: string): Promise<void> {
    assertUserId(userId);
    if (!/^[a-f0-9]{64}$/.test(meetingHash)) throw new Error("Recall transcript meeting identity is invalid.");
    await this.measuredQuery(this.database,
      `UPDATE chusky_object_metadata SET metadata = metadata || '{"truncated":true}'::jsonb, updated_at = now()
       WHERE owner_user_id = $1 AND object_kind = 'transcript_segment' AND metadata->>'meetingHash' = $2
         AND lifecycle_status IN ('pending','available','failed')`,
      [userId, meetingHash],
    );
  }

  /** Promote a verified immutable R2 object without changing its cataloged key. */
  async markObjectAvailableAtKey(userId: number, objectId: string, objectKey: string, sizeBytes: number, sha256: string, encryptionVersion: string): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId) || !isOwnerScopedObjectKey(userId, objectKey)
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !/^[a-f0-9]{64}$/.test(sha256)
      || encryptionVersion.length > 80 || !/^[A-Za-z0-9._-]+$/.test(encryptionVersion)) {
      throw new Error("Durable object verification is invalid.");
    }
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'available', size_bytes = $4, sha256 = $5, updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2 AND object_key = $3 AND lifecycle_status = 'pending'
         AND size_bytes = 0 AND encryption_version = $6
       RETURNING object_id`,
      [userId, objectId, objectKey, sizeBytes, sha256, encryptionVersion],
    );
    if (result.rows.length) return true;
    const existing = await this.getObjectMetadata(userId, objectId);
    return existing?.status === "available" && existing.objectKey === objectKey && existing.sizeBytes === sizeBytes
      && existing.sha256 === sha256 && existing.encryptionVersion === encryptionVersion;
  }

  /** Bounded cleanup scan; only explicitly expired catalog rows are eligible. */
  async listExpiredObjectMetadata(nowMs: number, limit = 100): Promise<DurableObjectMetadata[]> {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Durable object cleanup query bounds are invalid.");
    }
    const result = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256, encryption_version, retention_expires_at, metadata, created_at, updated_at
       FROM chusky_object_metadata
       WHERE retention_expires_at <= to_timestamp($1 / 1000.0) AND lifecycle_status IN ('pending','available','deleting','failed')
       ORDER BY retention_expires_at, owner_user_id, object_id
       LIMIT $2`,
      [nowMs, limit],
    );
    return result.rows.map(durableObjectFromRow);
  }

  /** Finalize an upload only when it still matches the pending owner-scoped intent. */
  async markObjectAvailable(userId: number, objectId: string, expectedUploadKey: string, finalObjectKey: string, sizeBytes: number, sha256: string, encryptionVersion?: string): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId) || !isOwnerScopedObjectKey(userId, expectedUploadKey) || !isOwnerScopedObjectKey(userId, finalObjectKey) || expectedUploadKey === finalObjectKey || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Durable object verification is invalid.");
    if (encryptionVersion !== undefined && (encryptionVersion.length > 80 || !/^[A-Za-z0-9._-]+$/.test(encryptionVersion))) throw new Error("Durable object encryption version is invalid.");
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'available', object_key = $4, size_bytes = $5, sha256 = $6, encryption_version = $7, updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2 AND lifecycle_status = 'pending' AND object_key = $3 AND size_bytes = $5
       RETURNING object_id`,
      [userId, objectId, expectedUploadKey, finalObjectKey, sizeBytes, sha256, encryptionVersion ?? null],
    );
    if (result.rows.length) return true;
    const existing = await this.getObjectMetadata(userId, objectId);
    return existing?.status === "available" && existing.sizeBytes === sizeBytes && existing.sha256 === sha256 && existing.encryptionVersion === encryptionVersion;
  }

  /** Start deletion before touching R2 so a retry can safely finish an interrupted delete. */
  async markObjectDeleting(userId: number, objectId: string): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId)) throw new Error("Durable object ID is invalid.");
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'deleting', retention_expires_at = now(), updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2 AND lifecycle_status IN ('pending','available','failed','deleting')
       RETURNING object_id`,
      [userId, objectId],
    );
    if (result.rows.length) return true;
    const existing = await this.getObjectMetadata(userId, objectId);
    return existing?.status === "deleted";
  }

  /** Claim expiry deletion only while the persisted deadline is still due. */
  async markExpiredObjectDeleting(userId: number, objectId: string, nowMs: number): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId) || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new Error("Expired object deletion claim is invalid.");
    }
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'deleting', updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2
         AND retention_expires_at <= to_timestamp($3 / 1000.0)
         AND lifecycle_status IN ('pending','available','failed','deleting')
       RETURNING object_id`,
      [userId, objectId, nowMs],
    );
    return result.rows.length > 0;
  }

  /** Mark deletion only after R2 confirms the delete request succeeded. */
  async markObjectDeleted(userId: number, objectId: string): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId)) throw new Error("Durable object ID is invalid.");
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'deleted', updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2 AND lifecycle_status = 'deleting'
       RETURNING object_id`,
      [userId, objectId],
    );
    if (result.rows.length) return true;
    const existing = await this.getObjectMetadata(userId, objectId);
    return existing?.status === "deleted";
  }

  /** Quarantine an upload that failed content verification, including a later read-back. */
  async markObjectFailed(userId: number, objectId: string): Promise<boolean> {
    assertUserId(userId);
    if (!/^obj_[A-Za-z0-9_-]{1,120}$/.test(objectId)) throw new Error("Durable object ID is invalid.");
    const result = await this.measuredQuery<{ object_id: string }>(this.database,
      `UPDATE chusky_object_metadata SET lifecycle_status = 'failed', updated_at = now()
       WHERE owner_user_id = $1 AND object_id = $2 AND lifecycle_status IN ('pending','available')
       RETURNING object_id`,
      [userId, objectId],
    );
    if (result.rows.length) return true;
    const existing = await this.getObjectMetadata(userId, objectId);
    return existing?.status === "failed";
  }

  /** Store one idempotent process-local batch with fixed metric-family labels only. */
  async recordStorageMetricBatch(instanceId: string, batchId: number, observedAt: number, samples: readonly StorageMetricSample[]): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) throw new Error("Storage metric instance identity is invalid.");
    if (!Number.isSafeInteger(batchId) || batchId <= 0) throw new Error("Storage metric batch identity is invalid.");
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error("Storage metric observation time is invalid.");
    if (!Array.isArray(samples) || samples.length < 1 || samples.length > REDIS_METRIC_FAMILIES.length) throw new Error("Storage metric batch size is invalid.");
    const seen = new Set<string>();
    for (const sample of samples) {
      if (!sample || !REDIS_FAMILY_SET.has(sample.family) || seen.has(sample.family)) throw new Error("Storage metric family is invalid or duplicated.");
      seen.add(sample.family);
      for (const metric of [sample.commands, sample.errors, sample.requestBytes, sample.responseBytes, sample.durationMs, sample.maxValueBytes]) {
        if (!Number.isSafeInteger(metric) || metric < 0) throw new Error("Storage metric aggregate is invalid.");
      }
      if (sample.errors > sample.commands) throw new Error("Storage metric error count exceeds command count.");
    }

    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      await this.measuredQuery(client,
        `INSERT INTO chusky_storage_metric_sample
          (instance_id, batch_id, family, observed_at, commands, errors, request_bytes, response_bytes, duration_ms, max_value_bytes)
         SELECT $1::uuid, $2::bigint, metric.family, to_timestamp($3 / 1000.0), metric.commands, metric.errors,
           metric.request_bytes, metric.response_bytes, metric.duration_ms, metric.max_value_bytes
         FROM unnest($4::text[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[])
           AS metric(family, commands, errors, request_bytes, response_bytes, duration_ms, max_value_bytes)
         ON CONFLICT (instance_id, batch_id, family) DO NOTHING`,
        [instanceId, batchId, observedAt, samples.map((item) => item.family), samples.map((item) => item.commands), samples.map((item) => item.errors), samples.map((item) => item.requestBytes), samples.map((item) => item.responseBytes), samples.map((item) => item.durationMs), samples.map((item) => item.maxValueBytes)],
      );
      await this.measuredQuery(client, "COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original write error. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Aggregate only a bounded recent window; raw process IDs are never returned. */
  async storageMetricTotals(sinceMs: number, windowDays = 1): Promise<StorageMetricTotals> {
    if (!Number.isSafeInteger(sinceMs) || sinceMs <= 0) throw new Error("Storage metric window start is invalid.");
    if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30) throw new Error("Storage metric window must be between 1 and 30 days.");
    const empty = Object.fromEntries(REDIS_METRIC_FAMILIES.map((family) => [family, { commands: 0, errors: 0, requestBytes: 0, responseBytes: 0, durationMs: 0, maxValueBytes: 0 }])) as StorageMetricTotals;
    const result = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT family, COALESCE(SUM(commands), 0)::text AS commands, COALESCE(SUM(errors), 0)::text AS errors,
         COALESCE(SUM(request_bytes), 0)::text AS request_bytes, COALESCE(SUM(response_bytes), 0)::text AS response_bytes,
         COALESCE(SUM(duration_ms), 0)::text AS duration_ms, COALESCE(MAX(max_value_bytes), 0)::text AS max_value_bytes
       FROM chusky_storage_metric_sample
       WHERE observed_at >= GREATEST(to_timestamp($1 / 1000.0), now() - ($2::integer * interval '1 day'))
       GROUP BY family`, [sinceMs, windowDays]);
    const count = (value: unknown): number => {
      const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Storage metric aggregate returned an invalid count.");
      return parsed;
    };
    for (const row of result.rows) {
      if (typeof row.family !== "string" || !REDIS_FAMILY_SET.has(row.family)) throw new Error("Storage metric aggregate returned an unknown family.");
      empty[row.family as RedisMetricFamily] = {
        commands: count(row.commands), errors: count(row.errors), requestBytes: count(row.request_bytes),
        responseBytes: count(row.response_bytes), durationMs: count(row.duration_ms), maxValueBytes: count(row.max_value_bytes),
      };
    }
    return empty;
  }

  /** Bounded retention sweep; callers repeat until fewer than `limit` rows are removed. */
  async pruneStorageMetrics(beforeMs: number, limit = 5000): Promise<number> {
    if (!Number.isSafeInteger(beforeMs) || beforeMs <= 0) throw new Error("Storage metric retention cutoff is invalid.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Storage metric prune limit is invalid.");
    const result = await this.measuredQuery<{ family: string }>(this.database,
      `WITH expired AS (
         SELECT ctid FROM chusky_storage_metric_sample WHERE observed_at < to_timestamp($1 / 1000.0)
         ORDER BY observed_at LIMIT $2
       )
       DELETE FROM chusky_storage_metric_sample target USING expired
       WHERE target.ctid = expired.ctid RETURNING target.family`, [beforeMs, limit]);
    return result.rows.length;
  }

  /** Persist aggregated PostgreSQL query/transfer counters without SQL text or payloads. */
  async recordQueryMetricBatch(batch: { instanceId: string; batchId: number; observedAt: number; samples: readonly QueryMetricSample[] }): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batch.instanceId)) throw new Error("Query metric instance identity is invalid.");
    if (!Number.isSafeInteger(batch.batchId) || batch.batchId <= 0 || !Number.isSafeInteger(batch.observedAt) || batch.observedAt <= 0 || !batch.samples.length || batch.samples.length > 1000) throw new Error("Query metric batch is invalid.");
    for (const sample of batch.samples) {
      if (!/^[a-f0-9]{64}$/.test(sample.queryHash) || !sample.queryFamily || sample.queryFamily.length > 120 || !Number.isSafeInteger(sample.commands) || !Number.isSafeInteger(sample.errors) || sample.errors > sample.commands || !Number.isSafeInteger(sample.requestBytes) || !Number.isSafeInteger(sample.responseBytes) || !Number.isSafeInteger(sample.durationMs) || !Number.isSafeInteger(sample.maxValueBytes) || [sample.commands, sample.errors, sample.requestBytes, sample.responseBytes, sample.durationMs, sample.maxValueBytes].some((value) => value < 0)) throw new Error("Query metric sample is invalid.");
    }
    await this.measuredQuery(this.database,
      `INSERT INTO chusky_query_metric_sample
       (instance_id, batch_id, query_hash, query_family, observed_at, commands, errors, request_bytes, response_bytes, duration_ms, max_value_bytes)
       SELECT $1::uuid, $2::bigint, metric.query_hash, metric.query_family, to_timestamp($3 / 1000.0), metric.commands, metric.errors,
         metric.request_bytes, metric.response_bytes, metric.duration_ms, metric.max_value_bytes
       FROM jsonb_to_recordset($4::jsonb) AS metric(query_hash text, query_family text, commands bigint, errors bigint, request_bytes bigint, response_bytes bigint, duration_ms bigint, max_value_bytes bigint)
       ON CONFLICT (instance_id, batch_id, query_hash) DO NOTHING`,
      [batch.instanceId, batch.batchId, batch.observedAt, JSON.stringify(batch.samples.map((sample) => ({
        query_hash: sample.queryHash, query_family: sample.queryFamily,
        commands: sample.commands, errors: sample.errors,
        request_bytes: sample.requestBytes, response_bytes: sample.responseBytes,
        duration_ms: sample.durationMs, max_value_bytes: sample.maxValueBytes,
      })))]);
  }

  async pruneQueryMetrics(beforeMs: number, limit = 5000): Promise<number> {
    if (!Number.isSafeInteger(beforeMs) || beforeMs <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Query metric retention arguments are invalid.");
    const result = await this.measuredQuery<{ query_hash: string }>(this.database,
      `WITH expired AS (SELECT ctid FROM chusky_query_metric_sample WHERE observed_at < to_timestamp($1 / 1000.0) ORDER BY observed_at LIMIT $2)
       DELETE FROM chusky_query_metric_sample target USING expired WHERE target.ctid = expired.ctid RETURNING target.query_hash`, [beforeMs, limit]);
    return result.rows.length;
  }

  /** Aggregate bounded query/transfer telemetry without returning SQL or payloads. */
  async queryMetricTotals(sinceMs: number, windowDays = 1): Promise<Record<string, number>> {
    if (!Number.isSafeInteger(sinceMs) || sinceMs <= 0 || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30) {
      throw new Error("Query metric window is invalid.");
    }
    const result = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT COALESCE(SUM(commands), 0)::text AS commands, COALESCE(SUM(errors), 0)::text AS errors,
         COALESCE(SUM(request_bytes), 0)::text AS request_bytes, COALESCE(SUM(response_bytes), 0)::text AS response_bytes,
         COALESCE(SUM(duration_ms), 0)::text AS duration_ms, COUNT(*)::text AS samples
       FROM chusky_query_metric_sample
       WHERE observed_at >= GREATEST(to_timestamp($1 / 1000.0), now() - ($2::integer * interval '1 day'))`, [sinceMs, windowDays]);
    const row = result.rows[0] ?? {};
    const count = (key: string): number => {
      const value = row[key];
      const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Query metric aggregate returned an invalid count.");
      return parsed;
    };
    const totals: Record<string, number> = {
      "postgres.query.samples.1d": count("samples"),
      "postgres.query.commands.1d": count("commands"),
      "postgres.query.errors.1d": count("errors"),
      "postgres.query.request_bytes.1d": count("request_bytes"),
      "postgres.query.response_bytes.1d": count("response_bytes"),
      "postgres.query.duration_ms.1d": count("duration_ms"),
    };
    const byRoute = await this.measuredQuery<Record<string, unknown>>(this.database,
      `SELECT query_family, COALESCE(SUM(commands), 0)::text AS commands, COALESCE(SUM(errors), 0)::text AS errors,
         COALESCE(SUM(request_bytes), 0)::text AS request_bytes, COALESCE(SUM(response_bytes), 0)::text AS response_bytes,
         COALESCE(SUM(duration_ms), 0)::text AS duration_ms, COUNT(*)::text AS samples
       FROM chusky_query_metric_sample
       WHERE observed_at >= GREATEST(to_timestamp($1 / 1000.0), now() - ($2::integer * interval '1 day'))
       GROUP BY query_family
       ORDER BY (SUM(request_bytes) + SUM(response_bytes)) DESC, query_family
       LIMIT 100`, [sinceMs, windowDays]);
    for (const route of byRoute.rows) {
      if (typeof route.query_family !== "string" || !route.query_family || route.query_family.length > 120) {
        throw new Error("Query metric route aggregate returned an invalid family.");
      }
      const routeKey = `${route.query_family.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 88) || "unknown"}_${createHash("sha256").update(route.query_family).digest("hex").slice(0, 8)}`;
      const routeCount = (key: string): number => {
        const value = route[key];
        const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Query metric route aggregate returned an invalid count.");
        return parsed;
      };
      totals[`postgres.query.route.${routeKey}.samples.1d`] = routeCount("samples");
      totals[`postgres.query.route.${routeKey}.commands.1d`] = routeCount("commands");
      totals[`postgres.query.route.${routeKey}.errors.1d`] = routeCount("errors");
      totals[`postgres.query.route.${routeKey}.request_bytes.1d`] = routeCount("request_bytes");
      totals[`postgres.query.route.${routeKey}.response_bytes.1d`] = routeCount("response_bytes");
      totals[`postgres.query.route.${routeKey}.duration_ms.1d`] = routeCount("duration_ms");
    }
    return totals;
  }

  /** Bounded retention for high-churn SDK and conversation rows. */
  async pruneDurableStateRetention(cutoffs: { messagesBeforeMs: number; auditBeforeMs: number; idempotencyBeforeMs: number; runsBeforeMs: number }, limit = 5000): Promise<Record<string, number>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || Object.values(cutoffs).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("Durable retention arguments are invalid.");
    const remove = async (table: string, column: string, cutoff: number): Promise<number> => {
      const result = await this.measuredQuery<Record<string, unknown>>(this.database,
        `WITH expired AS (SELECT ctid FROM ${table} WHERE ${column} < to_timestamp($1 / 1000.0) ORDER BY ${column} LIMIT $2)
         DELETE FROM ${table} target USING expired WHERE target.ctid = expired.ctid RETURNING 1`, [cutoff, limit]);
      return result.rows.length;
    };
    const runs = await this.measuredQuery<Record<string, unknown>>(this.database,
      `WITH expired AS (
         SELECT ctid FROM chusky_sdk_run
         WHERE updated_at < to_timestamp($1 / 1000.0)
           AND payload->>'status' IN ('completed', 'failed', 'cancelled')
         ORDER BY updated_at, run_id LIMIT $2
       )
       DELETE FROM chusky_sdk_run target USING expired
       WHERE target.ctid = expired.ctid RETURNING 1`, [cutoffs.runsBeforeMs, limit]);
    return {
      messages: await remove("chusky_conversation_message", "created_at", cutoffs.messagesBeforeMs),
      audit: await remove("chusky_sdk_audit_event", "created_at", cutoffs.auditBeforeMs),
      idempotency: await remove("chusky_sdk_idempotency", "created_at", cutoffs.idempotencyBeforeMs),
      runs: runs.rows.length,
    };
  }

  async assertStorageMetricsSchema(): Promise<void> {
    await this.measuredQuery(this.database,
      "SELECT instance_id, batch_id, family, observed_at, commands, errors, request_bytes, response_bytes, duration_ms, max_value_bytes FROM chusky_storage_metric_sample LIMIT 0");
  }

  /** Fail startup when the opt-in object catalog is enabled without migration 0008. */
  async assertObjectMetadataSchema(): Promise<void> {
    await this.measuredQuery(this.database,
      "SELECT owner_user_id, object_id, object_kind, object_key, lifecycle_status, content_type, size_bytes, sha256 FROM chusky_object_metadata LIMIT 0");
  }

  async assertRecallTranscriptArchiveSchema(): Promise<void> {
    const result = await this.measuredQuery<{ index_name: string | null }>(this.database,
      "SELECT to_regclass('public.chusky_object_metadata_transcript_meeting_idx')::text AS index_name");
    if (!result.rows[0]?.index_name) throw new Error("Recall transcript archive index migration is missing.");
  }

  /** Fail startup when the opt-in mission repository schema is not installed. */
  async assertMissionSchema(): Promise<void> {
    await this.measuredQuery(this.database,
      "SELECT owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at FROM chusky_mission LIMIT 0");
    await this.measuredQuery(this.database,
      "SELECT event_order, owner_user_id, mission_id, event_id, event_type, occurred_at, payload FROM chusky_mission_event LIMIT 0");
    await this.measuredQuery(this.database,
      "SELECT owner_user_id, mission_count, event_count, content_sha256, migrated_at FROM chusky_mission_owner_state LIMIT 0");
  }

  async isMissionOwnerMigrated(userId: number): Promise<boolean> {
    assertUserId(userId);
    const result = await this.measuredQuery<{ owner_user_id: string | number }>(this.database,
      "SELECT owner_user_id FROM chusky_mission_owner_state WHERE owner_user_id = $1", [userId]);
    return result.rows.length > 0;
  }

  /** Record cutover only after an external migration pass has verified counts and digest. */
  async markMissionOwnerMigrated(userId: number, missionCount: number, eventCount: number, contentSha256: string): Promise<void> {
    assertUserId(userId);
    if (!Number.isSafeInteger(missionCount) || missionCount < 0 || !Number.isSafeInteger(eventCount) || eventCount < 0 || !/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new Error("Mission migration verification metadata is invalid.");
    }
    const result = await this.measuredQuery<{ owner_user_id: string | number }>(this.database,
      `INSERT INTO chusky_mission_owner_state (owner_user_id, mission_count, event_count, content_sha256)
       VALUES ($1, $2, $3, $4) ON CONFLICT (owner_user_id) DO NOTHING RETURNING owner_user_id`,
      [userId, missionCount, eventCount, contentSha256]);
    if (result.rows.length) return;
    const existing = await this.measuredQuery<{ mission_count: number; event_count: string | number; content_sha256: string }>(this.database,
      "SELECT mission_count, event_count, content_sha256 FROM chusky_mission_owner_state WHERE owner_user_id = $1", [userId]);
    const row = existing.rows[0];
    if (!row || Number(row.mission_count) !== missionCount || Number(row.event_count) !== eventCount || row.content_sha256 !== contentSha256) {
      throw new Error("Mission owner migration marker conflicts with previously verified data.");
    }
  }

  async readMission(userId: number, missionId: string): Promise<DurableMissionRecord | undefined> {
    assertUserId(userId);
    if (!/^mis_[A-Za-z0-9_-]{1,160}$/.test(missionId)) throw new Error("Durable mission identity is invalid.");
    const result = await this.measuredQuery<MissionRow>(this.database,
      "SELECT owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at FROM chusky_mission WHERE owner_user_id = $1 AND mission_id = $2",
      [userId, missionId]);
    return result.rows[0] ? toDurableMission(result.rows[0]) : undefined;
  }

  async listMissions(userId: number, limit = 100, afterMissionId?: string): Promise<DurableMissionRecord[]> {
    assertUserId(userId);
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
    if (afterMissionId !== undefined && !/^mis_[A-Za-z0-9_-]{1,160}$/.test(afterMissionId)) throw new Error("Durable mission pagination cursor is invalid.");
    const result = await this.measuredQuery<MissionRow>(this.database,
      "SELECT owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at FROM chusky_mission WHERE owner_user_id = $1 AND ($2::text IS NULL OR mission_id > $2) ORDER BY mission_id LIMIT $3",
      [userId, afterMissionId ?? null, boundedLimit]);
    return result.rows.map(toDurableMission);
  }

  async listMissionOwnerIds(): Promise<number[]> {
    const result = await this.measuredQuery<{ owner_user_id: string | number }>(this.database,
      "SELECT DISTINCT owner_user_id FROM chusky_mission ORDER BY owner_user_id");
    return result.rows.map((row) => Number(row.owner_user_id)).filter((id) => Number.isSafeInteger(id) && id >= 0);
  }

  async createMission(record: DurableMissionRecord, initialEvents?: readonly DurableMissionEvent[]): Promise<DurableMissionRecord> {
    validateMissionRecord(record);
    const events = initialEvents ?? (Array.isArray(record.payload.events) ? record.payload.events as DurableMissionEvent[] : []);
    validateMissionEvents(events);
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      const inserted = await this.measuredQuery<MissionRow>(client,
        `INSERT INTO chusky_mission (owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
         ON CONFLICT DO NOTHING
         RETURNING owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at`,
        [record.ownerUserId, record.missionId, record.status, record.idempotencyKey ?? null, JSON.stringify(record.payload), record.version, record.createdAt, record.updatedAt]);
      if (inserted.rows[0]) {
        await this.insertMissionEvents(client, record.ownerUserId, record.missionId, events);
        await this.measuredQuery(client, "COMMIT");
        return toDurableMission(inserted.rows[0]);
      }
      const existing = await this.measuredQuery<MissionRow>(client,
        "SELECT owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at FROM chusky_mission WHERE owner_user_id = $1 AND (mission_id = $2 OR ($3::text IS NOT NULL AND idempotency_key = $3)) ORDER BY (mission_id = $2) DESC LIMIT 1",
        [record.ownerUserId, record.missionId, record.idempotencyKey ?? null]);
      await this.measuredQuery(client, "COMMIT");
      if (!existing.rows[0]) throw new Error("Durable mission create conflicted without an owner-scoped existing record.");
      return toDurableMission(existing.rows[0]);
    } catch (error) {
      await this.measuredQuery(client, "ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async compareAndUpdateMission(userId: number, missionId: string, expectedVersion: number, record: DurableMissionRecord, events: readonly DurableMissionEvent[]): Promise<DurableMissionRecord | undefined> {
    assertUserId(userId);
    validateMissionRecord(record);
    validateMissionEvents(events);
    if (record.ownerUserId !== userId || record.missionId !== missionId || record.version !== expectedVersion + 1) throw new Error("Durable mission update identity or version is invalid.");
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      const result = await this.measuredQuery<MissionRow>(client,
        `UPDATE chusky_mission SET status = $4, idempotency_key = $5, payload = $6::jsonb, version = $7,
           created_at = to_timestamp($8 / 1000.0), updated_at = to_timestamp($9 / 1000.0)
         WHERE owner_user_id = $1 AND mission_id = $2 AND version = $3
         RETURNING owner_user_id, mission_id, status, idempotency_key, payload, version, created_at, updated_at`,
        [userId, missionId, expectedVersion, record.status, record.idempotencyKey ?? null, JSON.stringify(record.payload), record.version, record.createdAt, record.updatedAt]);
      if (!result.rows[0]) {
        await this.measuredQuery(client, "ROLLBACK");
        return undefined;
      }
      await this.insertMissionEvents(client, userId, missionId, events);
      await this.measuredQuery(client, "COMMIT");
      return toDurableMission(result.rows[0]);
    } catch (error) {
      await this.measuredQuery(client, "ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async insertMissionEvents(queryable: Queryable, userId: number, missionId: string, events: readonly DurableMissionEvent[]): Promise<void> {
    validateMissionEvents(events);
    for (const event of events) {
      await this.measuredQuery(queryable,
        `INSERT INTO chusky_mission_event (owner_user_id, mission_id, event_id, event_type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6::jsonb)
         ON CONFLICT (owner_user_id, mission_id, event_id) DO NOTHING`,
        [userId, missionId, event.id, event.type, event.at, JSON.stringify(event)]);
    }
  }

  async appendMissionEvents(userId: number, missionId: string, events: readonly DurableMissionEvent[]): Promise<void> {
    assertUserId(userId);
    if (!/^mis_[A-Za-z0-9_-]{1,160}$/.test(missionId)) throw new Error("Durable mission identity is invalid.");
    validateMissionEvents(events);
    if (!events.length) return;
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      await this.insertMissionEvents(client, userId, missionId, events);
      await this.measuredQuery(client, "COMMIT");
    } catch (error) {
      await this.measuredQuery(client, "ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async listMissionEvents(userId: number, missionId: string, limit = 1000): Promise<DurableMissionEvent[]> {
    assertUserId(userId);
    if (!/^mis_[A-Za-z0-9_-]{1,160}$/.test(missionId)) throw new Error("Durable mission identity is invalid.");
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(5000, limit)) : 1000;
    const result = await this.measuredQuery<{ payload: unknown }>(this.database,
      `SELECT payload FROM (SELECT payload, event_order FROM chusky_mission_event
       WHERE owner_user_id = $1 AND mission_id = $2 ORDER BY event_order DESC LIMIT $3) recent
       ORDER BY event_order`, [userId, missionId, boundedLimit]);
    return result.rows.flatMap((row) => row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? [row.payload as DurableMissionEvent] : []);
  }

  /** Fail startup before enabling the durable conversation/domain schema. */
  async assertSessionSchema(): Promise<void> {
    await this.measuredQuery(this.database, "SELECT user_id, domain, payload, version FROM chusky_session_domain LIMIT 0");
    await this.measuredQuery(this.database, "SELECT user_id, message_id, role, content, source_id, created_at FROM chusky_conversation_message LIMIT 0");
    const constraint = await this.measuredQuery<{ definition: string }>(this.database,
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'chusky_session_domain'::regclass AND conname = 'chusky_session_domain_domain_check'");
    const definition = constraint.rows[0]?.definition ?? "";
    if (!definition.includes("profile") || !definition.includes("sdk")) throw new Error("Neon durable session-domain constraint is missing required domains; apply the latest durable-state migrations.");
  }

  /** Fail startup before enabling run cutover if migrations 0002 and 0005 are absent. */
  async assertSdkRunSchema(): Promise<void> {
    await this.measuredQuery(this.database, "SELECT user_id, thread_id, run_id, payload, version FROM chusky_sdk_run LIMIT 0");
  }

  async assertSdkTablesSchema(): Promise<void> {
    await this.measuredQuery(this.database, "SELECT user_id, thread_id, external_id, metadata, history, created_at, updated_at FROM chusky_sdk_thread LIMIT 0");
    await this.measuredQuery(this.database, "SELECT user_id, audit_id, action, request_id, status, created_at FROM chusky_sdk_audit_event LIMIT 0");
    await this.measuredQuery(this.database, "SELECT user_id, idempotency_key, fingerprint, response, created_at FROM chusky_sdk_idempotency LIMIT 0");
  }

  async assertQueryMetricsSchema(): Promise<void> {
    await this.measuredQuery(this.database, "SELECT instance_id, batch_id, query_hash, query_family, observed_at, commands, errors, request_bytes, response_bytes, duration_ms, max_value_bytes FROM chusky_query_metric_sample LIMIT 0");
  }

  async readSessionDomains(userId: number): Promise<Map<DurableSessionDomain, DurableSessionDocument>> {
    assertUserId(userId);
    const result = await this.measuredQuery<SessionRow>(this.database,
      "SELECT domain, payload, version, updated_at FROM chusky_session_domain WHERE user_id = $1 AND domain = ANY($2::text[])",
      [userId, DURABLE_SESSION_DOMAINS],
    );
    for (const row of result.rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row.payload), "utf8");
      this.metrics.sessionDomainBytesRead += bytes;
      this.metrics.largestSessionDomainBytes = Math.max(this.metrics.largestSessionDomainBytes, bytes);
    }
    return new Map(result.rows.map((row) => {
      const document = toDocument(row);
      return [document.domain, document] as const;
    }));
  }

  /** Read one canonical domain for optimistic reconciliation; never fan out to all domains. */
  async readSessionDomain(userId: number, domain: DurableSessionDomain): Promise<DurableSessionDocument | undefined> {
    assertUserId(userId);
    assertDomain(domain);
    const result = await this.measuredQuery<SessionRow>(this.database,
      "SELECT domain, payload, version, updated_at FROM chusky_session_domain WHERE user_id = $1 AND domain = $2",
      [userId, domain],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(row.payload), "utf8");
    this.metrics.sessionDomainBytesRead += bytes;
    this.metrics.largestSessionDomainBytes = Math.max(this.metrics.largestSessionDomainBytes, bytes);
    return toDocument(row);
  }

  /** Append idempotent, owner-scoped messages. Existing IDs are never overwritten. */
  async appendConversationMessages(userId: number, messages: readonly DurableConversationMessage[]): Promise<void> {
    assertUserId(userId);
    if (!messages.length) return;
    const unique = new Map<string, DurableConversationMessage>();
    for (const message of messages) {
      if (!/^[A-Za-z0-9:_-]{1,180}$/.test(message.id) || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || message.content.length > 12_000 || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0 || (message.sourceId !== undefined && (typeof message.sourceId !== "string" || message.sourceId.length > 160))) {
        throw new Error("Durable conversation message is invalid.");
      }
      unique.set(message.id, message);
    }
    const values = [...unique.values()];
    const payloadBytes = Buffer.byteLength(JSON.stringify(values), "utf8");
    const result = await this.measuredQuery<{ message_id: string }>(this.database,
      `INSERT INTO chusky_conversation_message (user_id, message_id, role, content, source_id, created_at)
       SELECT $1, item.message_id, item.role, item.content, item.source_id, to_timestamp(item.created_at / 1000.0)
       FROM jsonb_to_recordset($2::jsonb) AS item(message_id text, role text, content text, source_id text, created_at bigint)
       ON CONFLICT (user_id, message_id) DO NOTHING RETURNING message_id`,
      [userId, JSON.stringify(values.map(({ id, role, content, sourceId, createdAt }) => ({ message_id: id, role, content, source_id: sourceId ?? null, created_at: createdAt })))],
    );
    this.metrics.conversationMessagesWritten += result.rows.length;
    this.metrics.conversationBytesWritten += payloadBytes;
  }

  /** Recent hot context read; bounded regardless of the requested limit. */
  async readRecentConversation(userId: number, limit = 20): Promise<DurableConversationMessage[]> {
    assertUserId(userId);
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(30, limit)) : 20;
    const result = await this.measuredQuery<{ message_id: string; role: "user" | "assistant"; content: string; source_id: string | null; created_at: Date }>(this.database,
      `SELECT message_id, role, content, source_id, created_at FROM chusky_conversation_message
       WHERE user_id = $1 ORDER BY created_at DESC, message_id DESC LIMIT $2`, [userId, boundedLimit]);
    this.metrics.conversationMessagesRead += result.rows.length;
    this.metrics.conversationBytesRead += Buffer.byteLength(JSON.stringify(result.rows), "utf8");
    return result.rows.reverse().map((row) => ({ id: row.message_id, role: row.role, content: row.content, ...(row.source_id ? { sourceId: row.source_id } : {}), createdAt: row.created_at.getTime() }));
  }

  /** Older history is explicit and cursor-paginated; normal turns should not call this. */
  async readConversationBefore(userId: number, before: { createdAt: number; id: string }, limit = 50): Promise<DurableConversationMessage[]> {
    assertUserId(userId);
    if (!Number.isSafeInteger(before.createdAt) || before.createdAt < 0 || !/^[A-Za-z0-9:_-]{1,180}$/.test(before.id)) throw new Error("Conversation cursor is invalid.");
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
    const result = await this.measuredQuery<{ message_id: string; role: "user" | "assistant"; content: string; source_id: string | null; created_at: Date }>(this.database,
      `SELECT message_id, role, content, source_id, created_at FROM chusky_conversation_message
       WHERE user_id = $1 AND (created_at, message_id) < (to_timestamp($2 / 1000.0), $3)
       ORDER BY created_at DESC, message_id DESC LIMIT $4`, [userId, before.createdAt, before.id, boundedLimit]);
    this.metrics.conversationMessagesRead += result.rows.length;
    this.metrics.conversationBytesRead += Buffer.byteLength(JSON.stringify(result.rows), "utf8");
    return result.rows.reverse().map((row) => ({ id: row.message_id, role: row.role, content: row.content, ...(row.source_id ? { sourceId: row.source_id } : {}), createdAt: row.created_at.getTime() }));
  }

  /** Read only the bounded SDK row sets needed by a session cache miss. */
  async readSdkTables(userId: number, limits: { threads?: number; audit?: number; idempotency?: number } = {}): Promise<DurableSdkTableState> {
    assertUserId(userId);
    const threadLimit = Math.max(1, Math.min(100, Math.floor(limits.threads ?? 100)));
    const auditLimit = Math.max(1, Math.min(500, Math.floor(limits.audit ?? 500)));
    const idempotencyLimit = Math.max(1, Math.min(500, Math.floor(limits.idempotency ?? 500)));
    const [threads, audit, idempotency] = await Promise.all([
      this.measuredQuery<SdkThreadRow>(this.database,
        "SELECT user_id, thread_id, external_id, metadata, history, created_at, updated_at FROM chusky_sdk_thread WHERE user_id = $1 ORDER BY updated_at DESC, thread_id DESC LIMIT $2",
        [userId, threadLimit]),
      this.measuredQuery<SdkAuditRow>(this.database,
        "SELECT user_id, audit_id, action, request_id, status, created_at FROM chusky_sdk_audit_event WHERE user_id = $1 ORDER BY created_at DESC, audit_id DESC LIMIT $2",
        [userId, auditLimit]),
      this.measuredQuery<SdkIdempotencyRow>(this.database,
        "SELECT user_id, idempotency_key, fingerprint, response, created_at FROM chusky_sdk_idempotency WHERE user_id = $1 AND created_at >= now() - interval '24 hours' ORDER BY created_at DESC, idempotency_key DESC LIMIT $2",
        [userId, idempotencyLimit]),
    ]);
    return { threads: threads.rows.map(toSdkThread), audit: audit.rows.map(toSdkAudit), idempotency: idempotency.rows.map(toSdkIdempotency) };
  }

  /** Read only SDK threads for list/detail endpoints; never pull audit or idempotency rows. */
  async readSdkThreads(userId: number, limit = 100): Promise<DurableSdkThread[]> {
    assertUserId(userId);
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    const result = await this.measuredQuery<SdkThreadRow>(this.database,
      "SELECT user_id, thread_id, external_id, metadata, history, created_at, updated_at FROM chusky_sdk_thread WHERE user_id = $1 ORDER BY updated_at DESC, thread_id DESC LIMIT $2",
      [userId, boundedLimit]);
    return result.rows.map(toSdkThread);
  }

  /** Exact owner-scoped thread lookup for SDK mutations and polling. */
  async readSdkThread(userId: number, threadId: string): Promise<DurableSdkThread | undefined> {
    assertUserId(userId);
    assertSdkThreadIdentity(threadId);
    const result = await this.measuredQuery<SdkThreadRow>(this.database,
      "SELECT user_id, thread_id, external_id, metadata, history, created_at, updated_at FROM chusky_sdk_thread WHERE user_id = $1 AND thread_id = $2",
      [userId, threadId]);
    return result.rows[0] ? toSdkThread(result.rows[0]) : undefined;
  }

  /** Bounded owner-scoped audit read; no session document is loaded. */
  async readSdkAuditEvents(userId: number, afterMs = 0, limit = 500): Promise<DurableSdkAuditEvent[]> {
    assertUserId(userId);
    const boundedAfter = Number.isSafeInteger(afterMs) && afterMs >= 0 ? afterMs : 0;
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 500;
    const result = await this.measuredQuery<SdkAuditRow>(this.database,
      "SELECT user_id, audit_id, action, request_id, status, created_at FROM chusky_sdk_audit_event WHERE user_id = $1 AND created_at > to_timestamp($2 / 1000.0) ORDER BY created_at ASC, audit_id ASC LIMIT $3",
      [userId, boundedAfter, boundedLimit]);
    return result.rows.map(toSdkAudit);
  }

  /** Exact idempotency lookup; routine SDK writes never need the session document. */
  async readSdkIdempotency(userId: number, key: string): Promise<DurableSdkIdempotencyRecord | undefined> {
    assertUserId(userId);
    if (!key || key.length > 255) throw new Error("Durable SDK idempotency key is invalid.");
    const result = await this.measuredQuery<SdkIdempotencyRow>(this.database,
      "SELECT user_id, idempotency_key, fingerprint, response, created_at FROM chusky_sdk_idempotency WHERE user_id = $1 AND idempotency_key = $2 AND created_at >= now() - interval '24 hours'",
      [userId, key]);
    return result.rows[0] ? toSdkIdempotency(result.rows[0]) : undefined;
  }

  /** Atomic single-row idempotency write with fingerprint fencing. */
  async writeSdkIdempotency(record: DurableSdkIdempotencyRecord): Promise<void> {
    if (!Number.isSafeInteger(record.userId) || record.userId < 0 || !record.key || record.key.length > 255 || !/^[a-f0-9]{32,128}$/.test(record.fingerprint) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || safeJsonBytes(record.response) > 512_000) {
      throw new Error("Durable SDK idempotency record is invalid.");
    }
    const result = await this.measuredQuery(this.database,
      `INSERT INTO chusky_sdk_idempotency (user_id, idempotency_key, fingerprint, response, created_at)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0))
       ON CONFLICT (user_id, idempotency_key) DO UPDATE SET response = EXCLUDED.response, created_at = EXCLUDED.created_at
         WHERE chusky_sdk_idempotency.fingerprint = EXCLUDED.fingerprint
       RETURNING idempotency_key`,
      [record.userId, record.key, record.fingerprint, JSON.stringify(record.response), record.createdAt]);
    if (!result.rows.length) throw new Error("Durable SDK idempotency key conflicts with a different request fingerprint.");
  }

  /** Append one audit event without rereading or rewriting any session JSON. */
  async appendSdkAuditEvent(event: DurableSdkAuditEvent): Promise<void> {
    if (!Number.isSafeInteger(event.userId) || event.userId < 0 || !/^audit_[A-Za-z0-9_-]{1,180}$/.test(event.auditId) || !event.action || event.action.length > 240 || !event.requestId || event.requestId.length > 240 || !Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599 || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0) {
      throw new Error("Durable SDK audit event is invalid.");
    }
    await this.measuredQuery(this.database,
      `INSERT INTO chusky_sdk_audit_event (user_id, audit_id, action, request_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ON CONFLICT (user_id, audit_id) DO NOTHING`,
      [event.userId, event.auditId, event.action, event.requestId, event.status, event.createdAt]);
  }

  /** Apply only changed SDK rows in one owner-serialized transaction. */
  async writeSdkTableChanges(userId: number, changes: DurableSdkTableChanges): Promise<void> {
    assertUserId(userId);
    if (changes.threads.length > 100 || changes.deletedThreadIds.length > 100 || changes.audit.length > 500 || changes.idempotency.length > 500) throw new Error("Durable SDK change batch exceeds the storage bound.");
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      await this.measuredQuery(client, "SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
      await this.writeSdkTableChangesWithClient(client, userId, changes);
      await this.measuredQuery(client, "COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original write error. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeSdkTableChangesWithClient(client: Queryable, userId: number, changes: DurableSdkTableChanges): Promise<void> {
    const deleted = [...new Set(changes.deletedThreadIds)];
    for (const threadId of deleted) assertSdkThreadIdentity(threadId);
    if (deleted.length) await this.measuredQuery(client, "DELETE FROM chusky_sdk_thread WHERE user_id = $1 AND thread_id = ANY($2::text[])", [userId, deleted]);
    for (const thread of changes.threads) {
      if (thread.userId !== userId || !thread.externalId || thread.externalId.length > 200) throw new Error("Durable SDK thread owner or external identity is invalid.");
      assertSdkThreadIdentity(thread.threadId);
      if (!Number.isSafeInteger(thread.createdAt) || !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < thread.createdAt) throw new Error("Durable SDK thread timestamps are invalid.");
      const metadataBytes = Buffer.byteLength(JSON.stringify(thread.metadata ?? {}), "utf8");
      const historyBytes = Buffer.byteLength(JSON.stringify(thread.history ?? []), "utf8");
      if (metadataBytes > 128_000 || historyBytes > 512_000) throw new Error("Durable SDK thread payload exceeds the storage bound.");
      await this.measuredQuery(client,
        `INSERT INTO chusky_sdk_thread (user_id, thread_id, external_id, metadata, history, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
         ON CONFLICT (user_id, thread_id) DO UPDATE SET external_id = EXCLUDED.external_id, metadata = EXCLUDED.metadata,
           history = EXCLUDED.history, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
        [userId, thread.threadId, thread.externalId, JSON.stringify(thread.metadata ?? {}), JSON.stringify(thread.history ?? []), thread.createdAt, thread.updatedAt]);
    }
    for (const event of changes.audit) {
      if (event.userId !== userId || !/^audit_[A-Za-z0-9_-]{1,180}$/.test(event.auditId) || !event.action || event.action.length > 240 || !event.requestId || event.requestId.length > 240 || !Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599 || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0) throw new Error("Durable SDK audit event is invalid.");
      await this.measuredQuery(client,
        `INSERT INTO chusky_sdk_audit_event (user_id, audit_id, action, request_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ON CONFLICT (user_id, audit_id) DO NOTHING`,
        [userId, event.auditId, event.action, event.requestId, event.status, event.createdAt]);
    }
    for (const record of changes.idempotency) {
      if (record.userId !== userId || !record.key || record.key.length > 255 || !/^[a-f0-9]{32,128}$/.test(record.fingerprint) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw new Error("Durable SDK idempotency record is invalid.");
      if (Buffer.byteLength(JSON.stringify(record.response), "utf8") > 512_000) throw new Error("Durable SDK idempotency response exceeds the storage bound.");
      const result = await this.measuredQuery(client,
        `INSERT INTO chusky_sdk_idempotency (user_id, idempotency_key, fingerprint, response, created_at)
         VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0))
         ON CONFLICT (user_id, idempotency_key) DO UPDATE SET response = EXCLUDED.response, created_at = EXCLUDED.created_at
           WHERE chusky_sdk_idempotency.fingerprint = EXCLUDED.fingerprint RETURNING idempotency_key`,
        [userId, record.key, record.fingerprint, JSON.stringify(record.response), record.createdAt]);
      if (!result.rows.length) throw new Error("Durable SDK idempotency key conflicts with a different request fingerprint.");
    }
  }

  /** Write all supplied domains in one Postgres transaction. */
  async writeSessionDomains(userId: number, documents: ReadonlyMap<DurableSessionDomain, unknown>, sdkRuns: readonly { threadId: string; runId: string; payload: unknown; expectedVersion?: number }[] = [], expectedVersions: ReadonlyMap<DurableSessionDomain, number | undefined> = new Map(), sdkTableChanges?: DurableSdkTableChanges): Promise<Map<DurableSessionDomain, number>> {
    assertUserId(userId);
    if ([...documents.keys()].some((domain) => !DOMAIN_SET.has(domain))) {
      throw new Error("A durable session write contains an unknown domain.");
    }
    const versions = new Map<DurableSessionDomain, number>();
    let writtenBytes = 0;
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      // Session domains are owner-scoped documents. Serialize writes for one
      // owner across Railway replicas so normal web, Telegram, audit, and
      // background saves do not all race on the same optimistic version.
      await this.measuredQuery(client, "SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
      for (const [domain, payload] of documents) {
        const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        const expected = expectedVersions.get(domain);
        let result = await this.measuredQuery<{ version: number }>(client,
          `INSERT INTO chusky_session_domain (user_id, domain, payload, version, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, NOW())
           ON CONFLICT (user_id, domain) DO UPDATE
           SET payload = EXCLUDED.payload, version = chusky_session_domain.version + 1, updated_at = NOW()
           WHERE $4::integer IS NOT NULL AND chusky_session_domain.version = $4
           RETURNING version`,
          [userId, domain, JSON.stringify(payload), expected ?? null],
        );
        if (!result.rows.length) throw new Error(`Durable session domain version conflict: ${domain}.`);
        versions.set(domain, Number(result.rows[0]!.version));
        writtenBytes += bytes;
      }
      for (const run of sdkRuns) {
        await this.writeSdkRunWithClient(client, userId, run.threadId, run.runId, run.payload, run.expectedVersion);
      }
      if (sdkTableChanges) await this.writeSdkTableChangesWithClient(client, userId, sdkTableChanges);
      await this.measuredQuery(client, "COMMIT");
      this.metrics.sessionDomainWrites += documents.size;
      this.metrics.sessionDomainBytesWritten += writtenBytes;
      this.metrics.largestSessionDomainBytes = Math.max(this.metrics.largestSessionDomainBytes, writtenBytes ? Math.max(...[...documents.values()].map((payload) => Buffer.byteLength(JSON.stringify(payload), "utf8"))) : 0);
      return versions;
    } catch (error) {
      await this.measuredQuery(client, "ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Read a run by all three ownership dimensions; run IDs are not global auth. */
  async readSdkRun(userId: number, threadId: string, runId: string): Promise<DurableSdkRun | undefined> {
    assertUserId(userId);
    assertSdkRunIdentity(threadId, runId);
    const result = await this.measuredQuery<SdkRunRow>(this.database,
      "SELECT user_id, thread_id, run_id, payload, created_at, updated_at, version FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 AND run_id = $3",
      [userId, threadId, runId],
    );
    return result.rows[0] ? toSdkRun(result.rows[0]) : undefined;
  }

  /** List one thread's runs in stable creation order, with a hard query bound. */
  async listSdkRuns(userId: number, threadId: string, limit = 100): Promise<DurableSdkRun[]> {
    assertUserId(userId);
    if (!/^(?:thr|cli_thread)_[A-Za-z0-9_-]{1,120}$/.test(threadId)) throw new Error("Durable SDK thread identity is invalid.");
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
    const result = await this.measuredQuery<SdkRunRow>(this.database,
      "SELECT user_id, thread_id, run_id, payload, created_at, updated_at, version FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at ASC, run_id ASC LIMIT $3",
      [userId, threadId, boundedLimit],
    );
    return result.rows.map(toSdkRun);
  }

  /** Upsert one bounded SDK run without rewriting the SDK session document. */
  async writeSdkRun(userId: number, threadId: string, runId: string, payload: unknown, expectedVersion?: number): Promise<void> {
    assertUserId(userId);
    assertSdkRunIdentity(threadId, runId);
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined;
    if (!value || value.id !== runId || !["queued", "running", "requires_approval", "completed", "failed", "cancelled"].includes(String(value.status)) || !Array.isArray(value.events)) {
      throw new Error("Durable SDK run payload is invalid.");
    }
    const createdAt = Number(value.createdAt);
    const updatedAt = Number(value.updatedAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt) {
      throw new Error("Durable SDK run timestamps are invalid.");
    }
    const { durableVersion: _version, durablePayloadHash: _hash, ...persistedValue } = value;
    const result = await this.measuredQuery(this.database,
      `INSERT INTO chusky_sdk_run (user_id, thread_id, run_id, payload, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), 1)
       ON CONFLICT (user_id, run_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at, version = chusky_sdk_run.version + 1
       WHERE chusky_sdk_run.thread_id = EXCLUDED.thread_id
         AND chusky_sdk_run.created_at = EXCLUDED.created_at
         AND $7::bigint IS NOT NULL AND chusky_sdk_run.version = $7
       RETURNING run_id`,
      [userId, threadId, runId, JSON.stringify(persistedValue), createdAt, updatedAt, expectedVersion ?? null],
    );
    if (!result.rows.length) throw new Error("Durable SDK run version conflict or identity conflict; reload the latest run before retrying.");
  }

  private async writeSdkRunWithClient(client: Queryable, userId: number, threadId: string, runId: string, payload: unknown, expectedVersion?: number): Promise<void> {
    assertSdkRunIdentity(threadId, runId);
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (!value || value.id !== runId || !["queued", "running", "requires_approval", "completed", "failed", "cancelled"].includes(String(value.status)) || !Array.isArray(value.events)) {
      throw new Error("Durable SDK run payload is invalid.");
    }
    const createdAt = Number(value.createdAt);
    const updatedAt = Number(value.updatedAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt) throw new Error("Durable SDK run timestamps are invalid.");
    const { durableVersion: _version, durablePayloadHash: _hash, ...persistedValue } = value;
    const result = await this.measuredQuery(client,
      `INSERT INTO chusky_sdk_run (user_id, thread_id, run_id, payload, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), 1)
       ON CONFLICT (user_id, run_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at, version = chusky_sdk_run.version + 1
       WHERE chusky_sdk_run.thread_id = EXCLUDED.thread_id
         AND chusky_sdk_run.created_at = EXCLUDED.created_at
         AND $7::bigint IS NOT NULL AND chusky_sdk_run.version = $7
       RETURNING run_id`,
      [userId, threadId, runId, JSON.stringify(persistedValue), createdAt, updatedAt, expectedVersion ?? null],
    );
    if (!result.rows.length) throw new Error("Durable SDK run version conflict or identity conflict; reload the latest run before retrying.");
  }

  async deleteSdkRunsForThread(userId: number, threadId: string): Promise<void> {
    assertUserId(userId);
    if (!/^(?:thr|cli_thread)_[A-Za-z0-9_-]{1,120}$/.test(threadId)) throw new Error("Durable SDK thread identity is invalid.");
    await this.measuredQuery(this.database, "DELETE FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2", [userId, threadId]);
  }

  async deleteSdkRun(userId: number, threadId: string, runId: string): Promise<void> {
    assertUserId(userId);
    assertSdkRunIdentity(threadId, runId);
    await this.measuredQuery(this.database, "DELETE FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 AND run_id = $3", [userId, threadId, runId]);
  }

  async close(): Promise<void> { await this.database.end(); }
}

export async function createNeonDurableState(databaseUrl: string): Promise<NeonDurableState | undefined> {
  const connectionString = databaseUrl.trim();
  if (!connectionString) return undefined;
  // Keep the dependency dormant unless the explicit durable-state feature is
  // enabled. This also lets memory-only test runs exercise domain logic.
  const { Pool } = await import("pg");
  const { securePostgresConnectionString } = await import("./postgresConnection.js");
  return new NeonDurableState(new Pool({ connectionString: securePostgresConnectionString(connectionString), max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 }));
}
