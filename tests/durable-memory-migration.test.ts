import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("durable memory migration uses 0007 and preserves versioned facts with one active key", async () => {
  const sql = await readFile(new URL("../migrations/0007_durable_memory.sql", import.meta.url), "utf8");
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chusky_memory_items/);
  assert.match(sql, /DROP CONSTRAINT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS chusky_memory_items_one_active_key_idx[\s\S]*?WHERE status = 'active'/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /UNIQUE\s*\(owner_user_id,\s*scope_id,\s*memory_key,\s*status\)/);
});

test("durable memory migration command targets the numbered migration using a direct URL only", async () => {
  const script = await readFile(new URL("../src/migrate-durable-memory.ts", import.meta.url), "utf8");
  assert.match(script, /0007_durable_memory\.sql/);
  assert.match(script, /durableStateMigrationDatabaseUrl/);
  assert.match(script, /betterAuthMigrationDatabaseUrl/);
  assert.match(script, /hostname\.includes\("-pooler"\)/);
  assert.doesNotMatch(script, /durableMemoryDatabaseUrl\s*\|\|\s*config\.betterAuthDatabaseUrl/);
});

test("reflection migration is a reviewable staging queue, not an active fact table", async () => {
  const sql = await readFile(new URL("../migrations/0013_durable_memory_reflection.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chusky_memory_reflections/);
  assert.match(sql, /status IN \('queued','processing','needs_review','accepted','rejected','consolidated','duplicate','failed'\)/);
  assert.match(sql, /REFERENCES chusky_memory_sources/);
  assert.match(sql, /UNIQUE \(owner_user_id, idempotency_key\)/);
  assert.match(sql, /chusky_memory_reflections_review_idx/);
});
