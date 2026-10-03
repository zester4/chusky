import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { config } from "./config.js";

async function main(): Promise<void> {
  // Chusky's auth and durable state can intentionally share one Neon database.
  // Prefer the dedicated setting, while allowing existing installations to use
  // their already-configured direct Better Auth migration URL.
  const connectionString = config.durableStateMigrationDatabaseUrl || config.betterAuthMigrationDatabaseUrl;
  if (!connectionString) throw new Error("Set DURABLE_STATE_MIGRATION_DATABASE_URL or BETTER_AUTH_MIGRATION_DATABASE_URL to Neon's direct connection string before running durable-state migrations.");
  const sql = await readFile(resolve(process.cwd(), "migrations", "0001_neon_durable_session.sql"), "utf8");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

main().then(() => console.log("Neon durable-state migrations completed.")).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
