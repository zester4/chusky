import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_LOCK_ID = "74231881421077";
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/i;

/**
 * Apply numbered schema migrations once, in order. A session advisory lock
 * serializes deploys/operators; checksums prevent silently editing history.
 */
export async function applyDurableStateMigrations(
  pool: Pool,
  migrationsDirectory: string,
): Promise<{ applied: string[]; skipped: string[] }> {
  const files = (await readdir(migrationsDirectory)).filter((name) => MIGRATION_NAME.test(name)).sort();
  if (!files.length) throw new Error("No durable-state SQL migrations were found.");

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS chusky_durable_state_migration (
        migration_name TEXT PRIMARY KEY CHECK (migration_name ~ '^\\d{4}_[a-z0-9_-]+\\.sql$'),
        sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const ledger = await client.query<{ migration_name: string; sha256: string }>(
      "SELECT migration_name, sha256 FROM chusky_durable_state_migration",
    );
    const appliedHashes = new Map(ledger.rows.map((row) => [row.migration_name, row.sha256]));
    for (const recordedName of appliedHashes.keys()) {
      if (!files.includes(recordedName)) throw new Error(`Previously applied migration file is missing: ${recordedName}`);
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const name of files) {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      const sha256 = createHash("sha256").update(sql, "utf8").digest("hex");
      const recordedHash = appliedHashes.get(name);
      if (recordedHash !== undefined) {
        if (recordedHash !== sha256) throw new Error(`Previously applied migration checksum changed: ${name}; add a new migration instead.`);
        skipped.push(name);
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO chusky_durable_state_migration (migration_name, sha256) VALUES ($1, $2)",
        [name, sha256],
      );
      appliedHashes.set(name, sha256);
      applied.push(name);
    }
    return { applied, skipped };
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
