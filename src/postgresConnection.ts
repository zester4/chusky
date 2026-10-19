import type { PoolConfig } from "pg";
import { config } from "./config.js";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/**
 * Keep PostgreSQL connections on the current strict TLS behavior while
 * making the choice explicit for pg-connection-string's next major release.
 */
export function securePostgresConnectionString(value: string): string {
  const connectionString = value.trim();
  if (!connectionString) return connectionString;

  let url: URL;
  try { url = new URL(connectionString); }
  catch { return connectionString; }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) return connectionString;
  if (url.searchParams.get("sslmode")?.toLowerCase() === "verify-full") return connectionString;

  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

/**
 * Runtime pool policy for Neon-backed application traffic.
 *
 * Migrations deliberately do not use this helper: they use a direct URL and
 * their own single-connection settings. Keeping that distinction prevents a
 * pooled PgBouncer connection from being used for session-scoped migration
 * work while bounding the long-lived application pools.
 */
export function postgresPoolOptions(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: config.postgresPoolMax,
    idleTimeoutMillis: config.postgresIdleTimeoutMs,
    connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
    statement_timeout: config.postgresStatementTimeoutMs,
    query_timeout: config.postgresQueryTimeoutMs,
  };
}
