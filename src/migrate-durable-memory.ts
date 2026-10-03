import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { config } from "./config.js";

const connectionString = config.durableMemoryMigrationDatabaseUrl || config.durableMemoryDatabaseUrl || config.betterAuthMigrationDatabaseUrl || config.betterAuthDatabaseUrl;
if (!connectionString) throw new Error("Set DURABLE_MEMORY_MIGRATION_DATABASE_URL or DURABLE_MEMORY_DATABASE_URL before running durable-memory:migrate");
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
readFile(join(process.cwd(), "migrations", "0008_durable_memory.sql"), "utf8")
  .then((sql) => pool.query(sql))
  .then(() => console.log("Durable memory schema is ready."))
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => pool.end());
