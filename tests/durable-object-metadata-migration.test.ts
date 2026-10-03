import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Neon object metadata migration keeps payload bytes out of the catalog and indexes owner cleanup", async () => {
  const sql = await readFile(new URL("../migrations/0008_neon_object_metadata.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chusky_object_metadata/);
  assert.match(sql, /PRIMARY KEY \(owner_user_id, object_id\)/);
  assert.match(sql, /object_key TEXT NOT NULL UNIQUE/);
  assert.match(sql, /sha256 TEXT/);
  assert.match(sql, /size_bytes BIGINT/);
  assert.match(sql, /retention_expires_at TIMESTAMPTZ/);
  assert.match(sql, /encryption_version TEXT/);
  assert.match(sql, /chusky_object_metadata_owner_kind_idx/);
  assert.match(sql, /chusky_object_metadata_expiry_idx/);
  assert.doesNotMatch(sql, /\b(bytea|payload\s+jsonb)\b/i);
});
