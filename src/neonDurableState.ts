import type { QueryResultRow } from "pg";

export const DURABLE_SESSION_DOMAINS = ["conversation", "memories", "assets", "sdk"] as const;
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
type SdkRunRow = { user_id: string | number; thread_id: string; run_id: string; payload: unknown; created_at: Date; updated_at: Date };

const DOMAIN_SET = new Set<string>(DURABLE_SESSION_DOMAINS);

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 0) throw new Error("Durable state requires a non-negative integer user ID.");
}

function assertSdkRunIdentity(threadId: string, runId: string): void {
  if (!/^thr_[A-Za-z0-9_-]{1,120}$/.test(threadId) || !/^run_[A-Za-z0-9_-]{1,120}$/.test(runId)) {
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
    payload,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Date.now(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Date.now(),
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
  constructor(private readonly database: TransactionPool) {}

  /** Verify database reachability with a lightweight, non-data-bearing query. */
  async healthStatus(): Promise<DurableStateStatus> {
    try {
      await this.database.query("SELECT 1");
      return { enabled: true, reachable: true };
    } catch {
      return { enabled: true, reachable: false };
    }
  }

  async readSessionDomains(userId: number): Promise<Map<DurableSessionDomain, DurableSessionDocument>> {
    assertUserId(userId);
    const result = await this.database.query<SessionRow>(
      "SELECT domain, payload, version, updated_at FROM chusky_session_domain WHERE user_id = $1 AND domain = ANY($2::text[])",
      [userId, DURABLE_SESSION_DOMAINS],
    );
    return new Map(result.rows.map((row) => {
      const document = toDocument(row);
      return [document.domain, document] as const;
    }));
  }

  /** Write all supplied domains in one Postgres transaction. */
  async writeSessionDomains(userId: number, documents: ReadonlyMap<DurableSessionDomain, unknown>): Promise<void> {
    assertUserId(userId);
    if (documents.size !== DURABLE_SESSION_DOMAINS.length || DURABLE_SESSION_DOMAINS.some((domain) => !documents.has(domain))) {
      throw new Error("A durable session write must include every session domain.");
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      for (const domain of DURABLE_SESSION_DOMAINS) {
        await client.query(
          `INSERT INTO chusky_session_domain (user_id, domain, payload, version, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, NOW())
           ON CONFLICT (user_id, domain) DO UPDATE
           SET payload = EXCLUDED.payload, version = chusky_session_domain.version + 1, updated_at = NOW()`,
          [userId, domain, JSON.stringify(documents.get(domain))],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Read a run by all three ownership dimensions; run IDs are not global auth. */
  async readSdkRun(userId: number, threadId: string, runId: string): Promise<DurableSdkRun | undefined> {
    assertUserId(userId);
    assertSdkRunIdentity(threadId, runId);
    const result = await this.database.query<SdkRunRow>(
      "SELECT user_id, thread_id, run_id, payload, created_at, updated_at FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 AND run_id = $3",
      [userId, threadId, runId],
    );
    return result.rows[0] ? toSdkRun(result.rows[0]) : undefined;
  }

  /** List one thread's runs in stable creation order, with a hard query bound. */
  async listSdkRuns(userId: number, threadId: string, limit = 100): Promise<DurableSdkRun[]> {
    assertUserId(userId);
    if (!/^thr_[A-Za-z0-9_-]{1,120}$/.test(threadId)) throw new Error("Durable SDK thread identity is invalid.");
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
    const result = await this.database.query<SdkRunRow>(
      "SELECT user_id, thread_id, run_id, payload, created_at, updated_at FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at ASC, run_id ASC LIMIT $3",
      [userId, threadId, boundedLimit],
    );
    return result.rows.map(toSdkRun);
  }

  /** Upsert one bounded SDK run without rewriting the SDK session document. */
  async writeSdkRun(userId: number, threadId: string, runId: string, payload: unknown): Promise<void> {
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
    const result = await this.database.query(
      `INSERT INTO chusky_sdk_run (user_id, thread_id, run_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))
       ON CONFLICT (user_id, run_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
       WHERE chusky_sdk_run.thread_id = EXCLUDED.thread_id
         AND chusky_sdk_run.created_at = EXCLUDED.created_at
       RETURNING run_id`,
      [userId, threadId, runId, JSON.stringify(value), createdAt, updatedAt],
    );
    if (!result.rows.length) throw new Error("Durable SDK run identity conflicts with an existing owner run.");
  }

  async deleteSdkRunsForThread(userId: number, threadId: string): Promise<void> {
    assertUserId(userId);
    if (!/^thr_[A-Za-z0-9_-]{1,120}$/.test(threadId)) throw new Error("Durable SDK thread identity is invalid.");
    await this.database.query("DELETE FROM chusky_sdk_run WHERE user_id = $1 AND thread_id = $2", [userId, threadId]);
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
