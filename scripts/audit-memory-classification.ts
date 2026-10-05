import { writeFile } from "node:fs/promises";
import { poolForDurableMemory, durableMemoryConfigured } from "../src/memory/durable.js";

const output = process.argv[2] || "memory-classification-audit.json";
const personalSignals = /\b(my|me|i|daughter|son|wife|husband|partner|doctor|landlord|home|family|friend|divorce|rent|weekend|birthday)\b/i;

type Row = { id: string; owner_user_id: number; category: string; memory_key: string; value: string; sensitivity: string; status: string; scope_kind?: string | null; entity_id?: string | null };

if (!durableMemoryConfigured()) {
  throw new Error("Durable memory is not configured; set DURABLE_MEMORY_ENABLED and a Neon database URL before auditing.");
}

const db = poolForDurableMemory();
const rows = (await db.query(`
  SELECT m.id, m.owner_user_id, m.category, m.memory_key, m.value, m.sensitivity, m.status,
         m.entity_id, s.kind AS scope_kind
  FROM chusky_memory_items m
  LEFT JOIN chusky_memory_scopes s ON s.id = m.scope_id
  WHERE m.status = 'active'
  ORDER BY m.owner_user_id, m.updated_at DESC
`)).rows as Row[];

const byCategory: Record<string, number> = {};
const bySensitivity: Record<string, number> = {};
for (const row of rows) {
  byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
  bySensitivity[row.sensitivity] = (bySensitivity[row.sensitivity] ?? 0) + 1;
}

const suspects = rows.filter((row) => row.sensitivity === "normal"
  && ["fact", "business", "relationship", "project"].includes(row.category)
  && personalSignals.test(`${row.memory_key} ${row.value}`))
  .map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    category: row.category,
    key: row.memory_key.slice(0, 240),
    value: row.value.slice(0, 600),
    sensitivity: row.sensitivity,
    hasPersonScope: Boolean(row.entity_id || row.scope_kind === "client"),
  }));

await writeFile(output, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: "neon_durable_memory",
  totals: { active: rows.length, suspects: suspects.length },
  byCategory,
  bySensitivity,
  suspects,
}, null, 2) + "\n", { mode: 0o600 });

console.log(JSON.stringify({ output, active: rows.length, suspects: suspects.length, byCategory, bySensitivity }));
await db.end();
