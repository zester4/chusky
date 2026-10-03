import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyDurableStateMigrations } from "../src/durableStateMigrations.js";

class MigrationDatabase {
  readonly applied = new Map<string, string>();
  readonly executed: string[] = [];
  readonly locks: string[] = [];
  failOnSql?: string;

  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes("pg_advisory_lock")) this.locks.push("acquire");
        else if (sql.includes("pg_advisory_unlock")) this.locks.push("release");
        else if (sql.includes("SELECT migration_name, sha256")) {
          return { rows: [...this.applied].map(([migration_name, sha256]) => ({ migration_name, sha256 })) };
        } else if (sql.includes("INSERT INTO chusky_durable_state_migration")) {
          this.applied.set(String(values[0]), String(values[1]));
        } else if (!sql.includes("CREATE TABLE IF NOT EXISTS chusky_durable_state_migration")) {
          this.executed.push(sql.trim());
          if (sql.includes(this.failOnSql ?? "\u0000")) throw new Error("migration SQL rejected");
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
  }
}

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chusky-migrations-"));
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(path.join(directory, name), sql)));
  return directory;
}

test("durable migration runner applies missing migrations in order once under one lock", async () => {
  const directory = await migrationDirectory({
    "0002_second.sql": "SELECT 'second';",
    "0001_first.sql": "SELECT 'first';",
  });
  const database = new MigrationDatabase();
  try {
    const firstRun = await applyDurableStateMigrations(database as never, directory);
    const secondRun = await applyDurableStateMigrations(database as never, directory);
    assert.deepEqual(firstRun, { applied: ["0001_first.sql", "0002_second.sql"], skipped: [] });
    assert.deepEqual(secondRun, { applied: [], skipped: ["0001_first.sql", "0002_second.sql"] });
    assert.deepEqual(database.executed, ["SELECT 'first';", "SELECT 'second';"]);
    assert.deepEqual(database.locks, ["acquire", "release", "acquire", "release"]);
    assert.equal(database.applied.get("0001_first.sql"), createHash("sha256").update("SELECT 'first';").digest("hex"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable migration runner refuses to execute an applied migration whose checksum changed", async () => {
  const directory = await migrationDirectory({ "0001_first.sql": "SELECT 'changed';" });
  const database = new MigrationDatabase();
  database.applied.set("0001_first.sql", "0".repeat(64));
  try {
    await assert.rejects(() => applyDurableStateMigrations(database as never, directory), /checksum changed/);
    assert.deepEqual(database.executed, []);
    assert.deepEqual(database.locks, ["acquire", "release"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable migration runner does not record a migration that fails", async () => {
  const directory = await migrationDirectory({ "0001_broken.sql": "SELECT 'broken';" });
  const database = new MigrationDatabase();
  database.failOnSql = "SELECT 'broken';";
  try {
    await assert.rejects(() => applyDurableStateMigrations(database as never, directory), /migration SQL rejected/);
    assert.equal(database.applied.has("0001_broken.sql"), false);
    assert.deepEqual(database.locks, ["acquire", "release"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable migration runner refuses applied entries whose migration file is missing", async () => {
  const directory = await migrationDirectory({ "0002_second.sql": "SELECT 'second';" });
  const database = new MigrationDatabase();
  database.applied.set("0001_removed.sql", "a".repeat(64));
  try {
    await assert.rejects(() => applyDurableStateMigrations(database as never, directory), /applied migration file is missing/);
    assert.deepEqual(database.executed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
