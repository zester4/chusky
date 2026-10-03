import type { QueryResultRow } from "pg";
import { createHash } from "node:crypto";

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

export interface DurableConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sourceId?: string;
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

/**
 * Canonical durable documents for high-growth user-session domains. Redis
 * remains responsible for leases, cancellation signals, locks, rate limits,
 * and short-lived workflow coordination.
 */
export class NeonDurableState {
  private readonly metrics: DurableStateMetrics = { queryCount: 0, queryErrors: 0, queryDurationMs: 0, conversationMessagesRead: 0, conversationMessagesWritten: 0, conversationBytesRead: 0, conversationBytesWritten: 0, sessionDomainWrites: 0, sessionDomainBytesRead: 0, sessionDomainBytesWritten: 0, largestSessionDomainBytes: 0 };

  constructor(private readonly database: TransactionPool) {}

  private async measuredQuery<Row extends QueryResultRow = QueryResultRow>(queryable: Queryable, text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
    const startedAt = Date.now();
    this.metrics.queryCount += 1;
    try {
      return await queryable.query<Row>(text, values);
    } catch (error) {
      this.metrics.queryErrors += 1;
      throw error;
    } finally {
      this.metrics.queryDurationMs += Math.max(0, Date.now() - startedAt);
    }
  }

  /** Process-local aggregate only; never includes owner IDs or row contents. */
  getMetrics(): DurableStateMetrics { return { ...this.metrics }; }

  /** Verify database reachability with a lightweight, non-data-bearing query. */
  async healthStatus(): Promise<DurableStateStatus> {
    try {
      await this.measuredQuery(this.database, "SELECT 1");
      return { enabled: true, reachable: true };
    } catch {
      return { enabled: true, reachable: false };
    }
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

  /** Write all supplied domains in one Postgres transaction. */
  async writeSessionDomains(userId: number, documents: ReadonlyMap<DurableSessionDomain, unknown>, sdkRuns: readonly { threadId: string; runId: string; payload: unknown; expectedVersion?: number }[] = [], expectedVersions: ReadonlyMap<DurableSessionDomain, number | undefined> = new Map()): Promise<Map<DurableSessionDomain, number>> {
    assertUserId(userId);
    if ([...documents.keys()].some((domain) => !DOMAIN_SET.has(domain))) {
      throw new Error("A durable session write contains an unknown domain.");
    }
    const versions = new Map<DurableSessionDomain, number>();
    let writtenBytes = 0;
    const client = await this.database.connect();
    try {
      await this.measuredQuery(client, "BEGIN");
      for (const [domain, payload] of documents) {
        const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        const expected = expectedVersions.get(domain);
        const result = await this.measuredQuery<{ version: number }>(client,
          `INSERT INTO chusky_session_domain (user_id, domain, payload, version, updated_at)
           SELECT $1, $2, $3::jsonb, 1, NOW() WHERE $4::integer IS NULL
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
  return new NeonDurableState(new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 }));
}
