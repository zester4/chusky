import { Pool, type PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { UpstashKnowledgeStore, vectorConfigured } from "../lib/knowledge/vector.js";
import { getHotMemoryBrief, invalidateHotMemoryBriefs, setHotMemoryBrief } from "./hotCache.js";
import type { MemoryCategory, MemoryBrief, MemoryEdge, MemoryEntity, MemoryEntityType, MemoryPurpose, MemoryScopeKind, DurableMemoryRecord } from "./types.js";

const memoryPool = new Map<string, Pool>();
const MAX_LIMIT = 50;

function databaseUrl(): string {
  return config.durableMemoryDatabaseUrl || config.betterAuthDatabaseUrl;
}

export function durableMemoryConfigured(): boolean {
  return config.durableMemoryEnabled && Boolean(databaseUrl());
}

function pool(): Pool {
  const url = databaseUrl();
  if (!url) throw new Error("A Neon database URL is required for durable memory");
  let existing = memoryPool.get(url);
  if (!existing) {
    existing = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    existing.on("error", (error) => logger.error({ errorType: error instanceof Error ? error.name : "PostgresError" }, "Durable memory database pool error"));
    memoryPool.set(url, existing);
  }
  return existing;
}

/** Internal shared pool for the reflection worker; callers still enforce owner/scope checks. */
export function poolForDurableMemory(): Pool {
  return pool();
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
export const memoryScopeId = (kind: MemoryScopeKind, externalId: string): string => `scope_${hash(`${kind}:${externalId}`)}`;
const bounded = (value: string, max: number) => value.trim().slice(0, max);

function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function rowToMemory(row: Record<string, unknown>): DurableMemoryRecord {
  return {
    id: String(row.id), ownerUserId: Number(row.owner_user_id),
    scope: { id: String(row.scope_id), kind: row.scope_kind as MemoryScopeKind, externalId: String(row.scope_external_id) },
    category: row.category as MemoryCategory, key: String(row.memory_key), value: String(row.value),
    confidence: Number(row.confidence), sensitivity: row.sensitivity as "normal" | "sensitive", status: row.status as DurableMemoryRecord["status"],
    ...(row.source_id ? { source: { id: String(row.source_id), type: String(row.source_type ?? "unknown"), ...(row.source_ref ? { ref: String(row.source_ref) } : {}) } } : {}),
    ...(row.entity_id ? { entityId: String(row.entity_id) } : {}), ...(row.supersedes_id ? { supersedesId: String(row.supersedes_id) } : {}),
    validFrom: toMillis(row.valid_from) ?? Date.now(), ...(row.valid_until ? { validUntil: toMillis(row.valid_until) } : {}),
    ...(row.review_at ? { reviewAt: toMillis(row.review_at) } : {}), createdAt: toMillis(row.created_at) ?? Date.now(), updatedAt: toMillis(row.updated_at) ?? Date.now(),
    metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as DurableMemoryRecord["metadata"],
  };
}

async function ensureScope(client: PoolClient, ownerUserId: number, kind: MemoryScopeKind, externalId: string, name?: string): Promise<string> {
  const id = memoryScopeId(kind, externalId);
  await client.query(`INSERT INTO chusky_memory_scopes (id, owner_user_id, kind, external_id, name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=COALESCE(EXCLUDED.name, chusky_memory_scopes.name)`, [id, ownerUserId, kind, bounded(externalId, 180), name ? bounded(name, 200) : null]);
  // The owner can always read their personal scope. Organization grants must
  // be explicitly provisioned from Better Auth membership checks.
  if (["personal", "project", "client", "meeting", "conversation", "channel"].includes(kind)) await client.query(`INSERT INTO chusky_memory_grants (scope_id, subject_type, subject_id, permissions) VALUES ($1,'user',$2,ARRAY['read','write']) ON CONFLICT DO NOTHING`, [id, String(ownerUserId)]);
  return id;
}

export async function provisionMemoryScope(input: { ownerUserId: number; kind: MemoryScopeKind; externalId: string; name?: string; permissions?: Array<"read" | "write"> }): Promise<string> {
  if (!durableMemoryConfigured()) throw new Error("Durable memory is not configured");
  const client = await pool().connect();
  try { await client.query("BEGIN"); const id = await ensureScope(client, input.ownerUserId, input.kind, input.externalId, input.name); await client.query(`INSERT INTO chusky_memory_grants (scope_id,subject_type,subject_id,permissions) VALUES ($1,'user',$2,$3) ON CONFLICT (scope_id,subject_type,subject_id) DO UPDATE SET permissions=EXCLUDED.permissions`, [id, String(input.ownerUserId), input.permissions ?? ["read"]]); await client.query("COMMIT"); return id; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function grantMemoryScope(input: { scopeId: string; subjectType: "user" | "agent" | "service"; subjectId: string; permissions: Array<"read" | "write"> }): Promise<void> {
  if (!durableMemoryConfigured()) return;
  await pool().query(`INSERT INTO chusky_memory_grants (scope_id, subject_type, subject_id, permissions) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,subject_type,subject_id) DO UPDATE SET permissions=EXCLUDED.permissions`, [input.scopeId, input.subjectType, bounded(input.subjectId, 180), input.permissions]);
}

async function accessibleScopes(client: PoolClient, ownerUserId: number, scopes: Array<{ kind: MemoryScopeKind; externalId: string }>): Promise<string[]> {
  const result: string[] = [];
  for (const scope of scopes) {
    const id = memoryScopeId(scope.kind, scope.externalId);
    const allowed = await client.query(`SELECT 1 FROM chusky_memory_grants WHERE scope_id=$1 AND subject_type='user' AND subject_id=$2 AND 'read'=ANY(permissions)`, [id, String(ownerUserId)]);
    if (allowed.rowCount) result.push(id);
  }
  return result;
}

export async function saveDurableMemory(input: {
  ownerUserId: number; scope: { kind: MemoryScopeKind; externalId: string; name?: string }; category: MemoryCategory; key: string; value: string;
  confidence?: number; sensitivity: "normal" | "sensitive"; source?: { type: string; ref?: string; capturedAt?: number; metadata?: Record<string, unknown> };
  entityId?: string; reviewAt?: number; expiresAt?: number; metadata?: Record<string, string | number | boolean | null>; id?: string;
}): Promise<DurableMemoryRecord> {
  if (!durableMemoryConfigured()) throw new Error("Durable memory is not configured");
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0) throw new Error("Memory owner is invalid");
  const client = await pool().connect();
  let id = input.id ?? `mem_${randomUUID()}`;
  try {
    await client.query("BEGIN");
    const scopeId = await ensureScope(client, input.ownerUserId, input.scope.kind, input.scope.externalId, input.scope.name);
    const writable = await client.query(`SELECT 1 FROM chusky_memory_grants WHERE scope_id=$1 AND subject_type='user' AND subject_id=$2 AND 'write'=ANY(permissions)`, [scopeId, String(input.ownerUserId)]);
    if (!writable.rowCount) throw new Error("The memory scope does not grant this owner write access");
    // Updates create a new version. The application-level key remains the
    // stable identity while the row ID identifies one immutable revision.
    if ((await client.query(`SELECT 1 FROM chusky_memory_items WHERE id=$1`, [id])).rowCount) id = `mem_${randomUUID()}`;
    let sourceId: string | undefined;
    if (input.source) {
      sourceId = `source_${hash(`${input.ownerUserId}:${input.source.type}:${input.source.ref ?? id}`)}`;
      await client.query(`INSERT INTO chusky_memory_sources (id,owner_user_id,source_type,source_ref,captured_at,metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_user_id,source_type,source_ref) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING id`, [sourceId, input.ownerUserId, bounded(input.source.type, 120), input.source.ref ? bounded(input.source.ref, 500) : null, input.source.capturedAt ? new Date(input.source.capturedAt) : null, input.source.metadata ?? {}]);
    }
    const previous = await client.query(`SELECT id FROM chusky_memory_items WHERE owner_user_id=$1 AND scope_id=$2 AND memory_key=$3 AND status='active' FOR UPDATE`, [input.ownerUserId, scopeId, bounded(input.key, 240)]);
    const previousId = previous.rows[0]?.id as string | undefined;
    if (previousId) await client.query(`UPDATE chusky_memory_items SET status='superseded', updated_at=now() WHERE id=$1`, [previousId]);
    const inserted = await client.query(`INSERT INTO chusky_memory_items (id,owner_user_id,scope_id,source_id,entity_id,category,memory_key,value,confidence,sensitivity,status,supersedes_id,valid_until,review_at,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14) RETURNING *`, [id, input.ownerUserId, scopeId, sourceId ?? null, input.entityId ?? null, input.category, bounded(input.key, 240), bounded(input.value, 20_000), Math.max(0, Math.min(1, input.confidence ?? 1)), input.sensitivity, previousId ?? null, input.expiresAt ? new Date(input.expiresAt) : null, input.reviewAt ? new Date(input.reviewAt) : null, input.metadata ?? {}]);
    await client.query(`INSERT INTO chusky_memory_outbox (memory_id,operation) VALUES ($1,'upsert')`, [id]);
    await client.query("COMMIT");
    await invalidateHotMemoryBriefs(input.ownerUserId);
    const row = inserted.rows[0] as Record<string, unknown>;
    return rowToMemory({ ...row, scope_kind: input.scope.kind, scope_external_id: input.scope.externalId, source_type: input.source?.type, source_ref: input.source?.ref });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function forgetDurableMemory(input: { ownerUserId: number; keyOrId: string }): Promise<boolean> {
  if (!durableMemoryConfigured()) return false;
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`UPDATE chusky_memory_items SET status='deleted',updated_at=now() WHERE owner_user_id=$1 AND status='active' AND (id=$2 OR memory_key=$2) RETURNING id`, [input.ownerUserId, bounded(input.keyOrId, 240)]);
    for (const row of result.rows as Array<{ id: string }>) await client.query(`INSERT INTO chusky_memory_outbox (memory_id,operation) VALUES ($1,'delete')`, [row.id]);
    await client.query("COMMIT");
    await invalidateHotMemoryBriefs(input.ownerUserId);
    return Boolean(result.rowCount);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function searchDurableMemory(input: { ownerUserId: number; scopes: Array<{ kind: MemoryScopeKind; externalId: string }>; query?: string; category?: MemoryCategory; limit?: number; includeSensitive?: boolean }): Promise<DurableMemoryRecord[]> {
  if (!durableMemoryConfigured()) return [];
  const client = await pool().connect();
  try {
    const scopeIds = await accessibleScopes(client, input.ownerUserId, input.scopes);
    if (!scopeIds.length) return [];
    const values: unknown[] = [input.ownerUserId, scopeIds, input.category ?? null, input.query ? `%${input.query.trim().replace(/[%_]/g, "\\$&")}%` : null, input.includeSensitive === true ? ["normal", "sensitive"] : ["normal"], Math.max(1, Math.min(MAX_LIMIT, input.limit ?? 10))];
    const result = await client.query(`SELECT m.*, s.kind AS scope_kind, s.external_id AS scope_external_id, src.source_type, src.source_ref FROM chusky_memory_items m JOIN chusky_memory_scopes s ON s.id=m.scope_id LEFT JOIN chusky_memory_sources src ON src.id=m.source_id WHERE m.owner_user_id=$1 AND m.scope_id=ANY($2::text[]) AND m.status='active' AND (m.valid_until IS NULL OR m.valid_until>now()) AND (m.review_at IS NULL OR m.review_at>now()) AND ($3::text IS NULL OR m.category=$3) AND ($4::text IS NULL OR m.memory_key ILIKE $4 ESCAPE '\\' OR m.value ILIKE $4 ESCAPE '\\') AND m.sensitivity=ANY($5::text[]) ORDER BY m.confidence DESC,m.updated_at DESC LIMIT $6`, values);
    return result.rows.map((row) => rowToMemory(row as Record<string, unknown>));
  } finally { client.release(); }
}

export async function saveMemoryEntity(input: { ownerUserId: number; type: MemoryEntityType; canonicalName: string; aliases?: string[]; metadata?: Record<string, unknown> }): Promise<MemoryEntity> {
  if (!durableMemoryConfigured()) throw new Error("Durable memory is not configured");
  const result = await pool().query(`INSERT INTO chusky_memory_entities (id,owner_user_id,entity_type,canonical_name,aliases,metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_user_id,entity_type,canonical_name) DO UPDATE SET aliases=EXCLUDED.aliases,metadata=EXCLUDED.metadata,updated_at=now() RETURNING *`, [`ent_${randomUUID()}`, input.ownerUserId, input.type, bounded(input.canonicalName, 240), (input.aliases ?? []).slice(0, 50).map((item) => bounded(item, 180)), input.metadata ?? {}]);
  const row = result.rows[0] as Record<string, unknown>;
  return { id: String(row.id), ownerUserId: Number(row.owner_user_id), type: row.entity_type as MemoryEntityType, canonicalName: String(row.canonical_name), aliases: (row.aliases as string[]) ?? [], metadata: (row.metadata as MemoryEntity["metadata"]) ?? {} };
}

export async function saveMemoryEdge(input: { ownerUserId: number; scope: { kind: MemoryScopeKind; externalId: string }; fromEntityId: string; relation: string; toEntityId: string; sourceId?: string; confidence?: number }): Promise<MemoryEdge> {
  if (!durableMemoryConfigured()) throw new Error("Durable memory is not configured");
  const client = await pool().connect();
  try { await client.query("BEGIN"); const scopeId = await ensureScope(client, input.ownerUserId, input.scope.kind, input.scope.externalId); const writable = await client.query(`SELECT 1 FROM chusky_memory_grants WHERE scope_id=$1 AND subject_type='user' AND subject_id=$2 AND 'write'=ANY(permissions)`, [scopeId, String(input.ownerUserId)]); if (!writable.rowCount) throw new Error("The memory scope does not grant this owner write access"); const id = `edge_${randomUUID()}`; const result = await client.query(`INSERT INTO chusky_memory_edges (id,owner_user_id,scope_id,from_entity_id,relation,to_entity_id,source_id,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (owner_user_id,scope_id,from_entity_id,relation,to_entity_id,status) DO UPDATE SET confidence=EXCLUDED.confidence,updated_at=now() RETURNING *`, [id,input.ownerUserId,scopeId,input.fromEntityId,bounded(input.relation,100),input.toEntityId,input.sourceId ?? null,Math.max(0,Math.min(1,input.confidence ?? 1))]); await client.query("COMMIT"); const row=result.rows[0] as Record<string,unknown>; return { id:String(row.id),scopeId:String(row.scope_id),fromEntityId:String(row.from_entity_id),relation:String(row.relation),toEntityId:String(row.to_entity_id),confidence:Number(row.confidence),status:row.status as MemoryEdge["status"],...(row.source_id?{sourceId:String(row.source_id)}:{}) }; } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}

/** Fetch a purpose-specific bounded context packet; never returns an owner-wide memory dump. */
export async function getMemoryBrief(input: { ownerUserId: number; purpose: MemoryPurpose; query: string; scopes: Array<{ kind: MemoryScopeKind; externalId: string }>; includeSensitive?: boolean; limit?: number }): Promise<MemoryBrief> {
  const includeSensitive = input.includeSensitive === true && input.scopes.every((scope) => scope.kind === "personal");
  const cacheInput = { ownerUserId: input.ownerUserId, purpose: input.purpose, query: input.query, scopeIds: input.scopes.map((scope) => memoryScopeId(scope.kind, scope.externalId)).sort(), includeSensitive, limit: Math.min(input.limit ?? 12, 20) };
  const cached = await getHotMemoryBrief(cacheInput);
  if (cached) return cached;
  const memories = await searchDurableMemory({ ...input, includeSensitive, limit: Math.min(input.limit ?? 12, 20) });
  const scopeIds = [...new Set(memories.map((memory) => memory.scope.id))];
  const entityIds = memories.flatMap((memory) => memory.entityId ? [memory.entityId] : []);
  const entityResult = entityIds.length ? await pool().query(`SELECT * FROM chusky_memory_entities WHERE id=ANY($1::text[]) AND owner_user_id=$2`, [entityIds, input.ownerUserId]) : { rows: [] };
  const edgeResult = scopeIds.length ? await pool().query(`SELECT * FROM chusky_memory_edges WHERE owner_user_id=$1 AND scope_id=ANY($2::text[]) AND status='active' ORDER BY confidence DESC LIMIT 50`, [input.ownerUserId, scopeIds]) : { rows: [] };
  const entities = (entityResult.rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), ownerUserId: Number(row.owner_user_id), type: row.entity_type as MemoryEntityType, canonicalName: String(row.canonical_name), aliases: (row.aliases as string[]) ?? [], metadata: (row.metadata as MemoryEntity["metadata"]) ?? {} }));
  const edges = (edgeResult.rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), scopeId: String(row.scope_id), fromEntityId: String(row.from_entity_id), relation: String(row.relation), toEntityId: String(row.to_entity_id), confidence: Number(row.confidence), status: row.status as MemoryEdge["status"], ...(row.source_id ? { sourceId: String(row.source_id) } : {}) }));
  const brief = { purpose: input.purpose, scopeIds, profile: memories.slice(0, 6).map((memory) => `- [${memory.category}] ${memory.key}: ${memory.value}`).join("\n"), memories, entities, edges, sourceIds: [...new Set(memories.flatMap((memory) => memory.source?.id ? [memory.source.id] : []))] };
  await setHotMemoryBrief(cacheInput, brief);
  return brief;
}

export async function drainMemoryVectorOutbox(limit = 50): Promise<{ processed: number; failed: number }> {
  if (!durableMemoryConfigured()) return { processed: 0, failed: 0 };
  const claimed = await pool().query(`WITH next AS (SELECT o.id FROM chusky_memory_outbox o WHERE o.completed_at IS NULL AND o.available_at<=now() AND (o.claimed_at IS NULL OR o.claimed_at<now()-interval '5 minutes') ORDER BY o.id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE chusky_memory_outbox o SET claimed_at=now(),attempts=o.attempts+1 FROM next WHERE o.id=next.id RETURNING o.id,o.operation,o.memory_id`, [Math.max(1, Math.min(200, limit))]);
  let processed = 0; let failed = 0;
  for (const item of claimed.rows as Array<{ id: number; operation: "upsert" | "delete"; memory_id: string }>) {
    try {
      const memory = await pool().query(`SELECT m.*, s.kind AS scope_kind, s.external_id AS scope_external_id FROM chusky_memory_items m JOIN chusky_memory_scopes s ON s.id=m.scope_id WHERE m.id=$1`, [item.memory_id]);
      const row = memory.rows[0] as Record<string, unknown> | undefined;
      if (vectorConfigured() && row) {
        const vector = new UpstashKnowledgeStore();
        const projectId = row.scope_kind === "project" ? String(row.scope_external_id) : undefined;
        if (item.operation === "delete" || row.status === "deleted") await vector.deleteMemory(String(row.owner_user_id), String(row.id), projectId);
        else await vector.upsertMemory({ userId: String(row.owner_user_id), id: String(row.id), category: String(row.category), key: String(row.memory_key), value: String(row.value), projectId });
      }
      await pool().query(`UPDATE chusky_memory_outbox SET completed_at=now(),last_error=NULL WHERE id=$1`, [item.id]);
      processed += 1;
    } catch (error) {
      failed += 1;
      await pool().query(`UPDATE chusky_memory_outbox SET available_at=now()+interval '1 minute',last_error=$2,claimed_at=NULL WHERE id=$1`, [item.id, error instanceof Error ? error.message.slice(0, 500) : "vector projection failed"]);
    }
  }
  return { processed, failed };
}
