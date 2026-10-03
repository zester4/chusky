import type { QueryResultRow } from "pg";

export const DURABLE_SESSION_DOMAINS = ["conversation", "memories", "assets", "sdk"] as const;
export type DurableSessionDomain = typeof DURABLE_SESSION_DOMAINS[number];

export interface DurableSessionDocument {
  domain: DurableSessionDomain;
  payload: unknown;
  version: number;
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

const DOMAIN_SET = new Set<string>(DURABLE_SESSION_DOMAINS);

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 0) throw new Error("Durable state requires a non-negative integer user ID.");
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
