import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { config } from "./config.js";

const connectionString = config.durableMemoryMigrationDatabaseUrl || config.durableStateMigrationDatabaseUrl || config.betterAuthMigrationDatabaseUrl;
if (!connectionString) throw new Error("Set a direct migration URL (DURABLE_MEMORY_MIGRATION_DATABASE_URL, DURABLE_STATE_MIGRATION_DATABASE_URL, or BETTER_AUTH_MIGRATION_DATABASE_URL) before running durable-memory:migrate");
const parsedUrl = new URL(connectionString);
if (parsedUrl.hostname.includes("-pooler")) throw new Error("Durable memory migrations require a direct, non-pooler Neon connection URL");
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
Promise.all([
  readFile(join(process.cwd(), "migrations", "0007_durable_memory.sql"), "utf8"),
  readFile(join(process.cwd(), "migrations", "0013_durable_memory_reflection.sql"), "utf8"),
  readFile(join(process.cwd(), "migrations", "0014_durable_memory_meeting_safe.sql"), "utf8"),
]).then(([base, reflection, meetingSafe]) => pool.query(`${base}\n${reflection}\n${meetingSafe}`))
  .then(async () => {
    const expectedTables = [
      "chusky_memory_scopes", "chusky_memory_grants", "chusky_memory_sources",
      "chusky_memory_entities", "chusky_memory_items", "chusky_memory_edges",
      "chusky_memory_profiles", "chusky_memory_outbox", "chusky_memory_reflections",
    ];
    const expectedIndexes = ["chusky_memory_items_one_active_key_idx", "chusky_memory_outbox_ready_idx", "chusky_memory_reflections_ready_idx"];
    const [tables, indexes] = await Promise.all([
      pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])", [expectedTables]),
      pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])", [expectedIndexes]),
    ]);
    const foundTables = new Set(tables.rows.map((row: { table_name: string }) => row.table_name));
    const foundIndexes = new Set(indexes.rows.map((row: { indexname: string }) => row.indexname));
    const missing = [...expectedTables.filter((name) => !foundTables.has(name)), ...expectedIndexes.filter((name) => !foundIndexes.has(name))];
    if (missing.length) throw new Error(`Durable memory migration verification failed; missing schema objects: ${missing.join(", ")}`);
    console.log(`Durable memory schema is ready (${expectedTables.length} tables and ${expectedIndexes.length} indexes verified).`);
  })
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => pool.end());
