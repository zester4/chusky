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
