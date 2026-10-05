import { createHash } from "node:crypto";
import { config } from "../config.js";
import { poolForDurableMemory, durableMemoryConfigured, memoryScopeId, provisionMemoryScope, saveDurableMemory } from "./durable.js";
import type { MemoryCategory, MemoryScopeKind } from "./types.js";
import { classifyMemory } from "./classifier.js";

export type ReflectionStatus = "queued" | "processing" | "needs_review" | "accepted" | "rejected" | "consolidated" | "duplicate" | "failed";

export interface MemoryCandidate {
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  sensitivity: "normal" | "sensitive";
  explicit: boolean;
  reason: "owner_statement" | "owner_preference" | "meeting_decision" | "inference";
  reviewAt?: number;
  meetingSafe?: boolean;
}

const bounded = (value: string, max: number) => value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 48);
const sensitive = /\b(password|passcode|secret|api[ _-]?key|ssn|social security|health|medical|diagnos|bank|credit card|routing number|salary|income|home address|private address)\b|\b(?:\+?\d[\d ()-]{8,}\d)\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export function isMemoryTextSensitive(value: string): boolean { return sensitive.test(value); }

function candidate(category: MemoryCategory, key: string, value: string, reason: MemoryCandidate["reason"], explicit: boolean): MemoryCandidate {
  const cleanValue = bounded(value.replace(/[.!?]+$/, ""), 2000);
  const isSensitive = sensitive.test(cleanValue);
  return {
    category, key: bounded(key, 240), value: cleanValue,
    confidence: isSensitive ? 0.65 : explicit ? 0.99 : 0.55,
    sensitivity: isSensitive ? "sensitive" : "normal",
    explicit, reason,
    ...(isSensitive || !explicit ? { reviewAt: Date.now() + 7 * 24 * 60 * 60_000 } : {}),
  };
}

/**
 * Extract only bounded, explainable candidates from owner-authored text.
 * This intentionally does not use a model: an automatic reflection pass must
 * never turn a vague conversational observation into a durable fact.
 */
export function extractMemoryCandidates(text: string): MemoryCandidate[] {
  const input = bounded(text, 8000);
  if (!input) return [];
  const results: MemoryCandidate[] = [];
  const remember = input.match(/\b(?:remember|keep in mind|don't forget)\s+(?:that\s+)?(.+)/i);
  if (remember?.[1]) results.push(candidate("fact", "conversation.remembered", remember[1], "owner_statement", true));
  const preference = input.match(/\b(?:i|we)\s+(?:prefer|like|usually use|always want)\s+(.+)/i);
  if (preference?.[1]) results.push(candidate("preference", "owner.preference", preference[1], "owner_preference", true));
  const timezone = input.match(/\bmy\s+timezone\s+is\s+([A-Za-z0-9_./+-]+)\b/i);
  if (timezone?.[1]) results.push(candidate("profile", "profile.timezone", timezone[1], "owner_statement", true));
  const decision = input.match(/\b(?:we|the team)\s+(?:decided|agreed)\s+(?:that\s+)?(.+)/i);
  if (decision?.[1]) results.push(candidate("project", "project.decision", decision[1], "meeting_decision", true));
  // Preserve a reviewable lead for explicit uncertainty, but never activate it.
  const uncertain = input.match(/\b(?:i think|probably|it seems|maybe|likely)\s+(.+)/i);
  if (uncertain?.[1] && results.length === 0) results.push(candidate("episodic", "conversation.observation", uncertain[1], "inference", false));
  return results.slice(0, 4);
}

function initialStatus(item: MemoryCandidate): ReflectionStatus {
  return item.explicit && item.sensitivity === "normal" && item.confidence >= 0.9 ? "accepted" : "needs_review";
}

export async function queueConversationReflection(input: {
  ownerUserId: number;
  text: string;
  sourceType?: "conversation" | "meeting" | "call";
  sourceRef?: string;
  scope?: { kind: MemoryScopeKind; externalId: string };
}): Promise<{ queued: number; candidates: MemoryCandidate[] }> {
  if (!durableMemoryConfigured()) return { queued: 0, candidates: [] };
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0) throw new Error("Reflection owner is invalid");
  const scope = input.scope ?? { kind: "personal" as const, externalId: String(input.ownerUserId) };
  // Personal scopes are safe to bootstrap. Organization/team scopes must have
  // been provisioned by membership-aware code before reflection can write.
  if (["personal", "meeting", "conversation", "channel"].includes(scope.kind)) await provisionMemoryScope({ ownerUserId: input.ownerUserId, kind: scope.kind, externalId: scope.externalId, permissions: ["read", "write"] });
  const scopeId = memoryScopeId(scope.kind, scope.externalId);
  const items = extractMemoryCandidates(input.text);
  if (!items.length) return { queued: 0, candidates: [] };
  const sourceType = input.sourceType ?? "conversation";
  const sourceRef = bounded(input.sourceRef ?? `${sourceType}:${digest(input.text)}`, 500);
  const sourceId = `source_${digest(`${input.ownerUserId}:${sourceType}:${sourceRef}`)}`;
  const client = await poolForDurableMemory().connect();
  let queued = 0;
  try {
    await client.query("BEGIN");
    const scopeGrant = await client.query(`SELECT 1 FROM chusky_memory_scopes s JOIN chusky_memory_grants g ON g.scope_id=s.id WHERE s.id=$1 AND s.owner_user_id=$2 AND g.subject_type='user' AND g.subject_id=$2 AND 'write'=ANY(g.permissions)`, [scopeId, input.ownerUserId]);
    if (!scopeGrant.rowCount) throw new Error("The reflection scope does not grant this owner write access");
    await client.query(`INSERT INTO chusky_memory_sources (id,owner_user_id,source_type,source_ref,captured_at,metadata) VALUES ($1,$2,$3,$4,now(),'{}'::jsonb) ON CONFLICT (owner_user_id,source_type,source_ref) DO NOTHING`, [sourceId, input.ownerUserId, sourceType, sourceRef]);
    for (const item of items) {
      const idempotencyKey = digest(`${input.ownerUserId}:${scopeId}:${sourceId}:${item.category}:${item.key}:${item.value}`);
      const result = await client.query(`INSERT INTO chusky_memory_reflections (id,owner_user_id,source_id,scope_id,idempotency_key,candidate,status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (owner_user_id,idempotency_key) DO NOTHING`, [`refl_${idempotencyKey}`, input.ownerUserId, sourceId, scopeId, idempotencyKey, JSON.stringify(item), initialStatus(item)]);
      queued += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return { queued, candidates: items };
}

export async function reviewMemoryReflection(input: { ownerUserId: number; reflectionId: string; decision: "accept" | "reject" }): Promise<boolean> {
  if (!durableMemoryConfigured()) return false;
  const result = await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status=$3,reviewed_at=now(),reviewed_by=$1,updated_at=now() WHERE id=$2 AND owner_user_id=$1 AND status='needs_review'`, [input.ownerUserId, input.reflectionId, input.decision === "accept" ? "accepted" : "rejected"]);
  return Boolean(result.rowCount);
}

export async function drainMemoryReflectionQueue(limit = 20): Promise<{ processed: number; reviewed: number; failed: number }> {
  if (!durableMemoryConfigured()) return { processed: 0, reviewed: 0, failed: 0 };
  const claimed = await poolForDurableMemory().query(`WITH next AS (SELECT id FROM chusky_memory_reflections WHERE status IN ('queued','accepted') AND (claimed_at IS NULL OR claimed_at < now()-interval '5 minutes') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE chusky_memory_reflections r SET status='processing',claimed_at=now(),attempts=attempts+1,updated_at=now() FROM next WHERE r.id=next.id RETURNING r.*`, [Math.max(1, Math.min(100, limit))]);
  let processed = 0; let reviewed = 0; let failed = 0;
  for (const row of claimed.rows as Array<Record<string, unknown>>) {
    const item = row.candidate as MemoryCandidate;
    try {
      if (row.status === "processing" && !row.reviewed_at && (!item.explicit || item.sensitivity === "sensitive" || item.confidence < 0.9)) {
        await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status='needs_review',claimed_at=NULL,updated_at=now() WHERE id=$1`, [row.id]);
        reviewed += 1;
        continue;
      }
      const classification = config.memoryClassificationEnabled
        ? await classifyMemory({ key: item.key, value: item.value, category: item.category, sensitivity: item.sensitivity, explicit: item.explicit, sessionId: `memory-reflection:${row.id}` })
        : undefined;
      if (classification && (!item.explicit && (classification.confidence < 0.9 || classification.category !== item.category))) {
        await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status='needs_review',claimed_at=NULL,updated_at=now(),candidate=$2 WHERE id=$1`, [row.id, JSON.stringify({ ...item, category: classification.category, meetingSafe: false })]);
        reviewed += 1;
        continue;
      }
      const duplicate = await poolForDurableMemory().query(`SELECT 1 FROM chusky_memory_items WHERE owner_user_id=$1 AND scope_id=$2 AND memory_key=$3 AND value=$4 AND status='active' LIMIT 1`, [row.owner_user_id, row.scope_id, item.key, item.value]);
      if (duplicate.rowCount) {
        await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status='duplicate',claimed_at=NULL,updated_at=now() WHERE id=$1`, [row.id]);
        continue;
      }
      const scope = await poolForDurableMemory().query(`SELECT kind,external_id FROM chusky_memory_scopes WHERE id=$1 AND owner_user_id=$2`, [row.scope_id, row.owner_user_id]);
      const scopeRow = scope.rows[0] as { kind: MemoryScopeKind; external_id: string } | undefined;
      if (!scopeRow) throw new Error("Reflection scope not found for owner");
      const source = (await poolForDurableMemory().query("SELECT source_type,source_ref FROM chusky_memory_sources WHERE id=$1", [row.source_id])).rows[0] as { source_type?: string; source_ref?: string } | undefined;
      await saveDurableMemory({ ownerUserId: Number(row.owner_user_id), scope: { kind: scopeRow.kind, externalId: scopeRow.external_id }, category: classification?.category ?? item.category, key: item.key, value: item.value, confidence: classification?.confidence ?? item.confidence, sensitivity: classification?.audience === "sensitive" ? "sensitive" : item.sensitivity, meetingSafe: classification?.meetingSafe === true, reviewAt: item.reviewAt, source: { type: source?.source_type ?? "conversation", ref: source?.source_ref ?? String(row.source_id), metadata: { reflectionId: String(row.id), reason: item.reason } } });
      await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status='consolidated',claimed_at=NULL,updated_at=now(),last_error=NULL WHERE id=$1`, [row.id]);
      processed += 1;
    } catch (error) {
      failed += 1;
      await poolForDurableMemory().query(`UPDATE chusky_memory_reflections SET status='failed',claimed_at=NULL,last_error=$2,updated_at=now() WHERE id=$1`, [row.id, error instanceof Error ? error.message.slice(0, 500) : "consolidation failed"]);
    }
  }
  return { processed, reviewed, failed };
}
