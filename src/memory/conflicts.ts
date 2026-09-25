import type { MemoryRecord } from "./types.js";

export interface MemoryConflict {
  key: string;
  category: MemoryRecord["category"];
  records: Array<{ id: string; value: string; confidence: number; source: string; updatedAt: number; status: MemoryRecord["status"] }>;
  recommendedId?: string;
  reason: string;
}

/** Find competing active facts without exposing values outside the owner scope. */
export function detectMemoryConflicts(records: readonly MemoryRecord[], now = Date.now()): MemoryConflict[] {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    if (record.status !== "active" || (record.expiresAt !== undefined && record.expiresAt <= now)) continue;
    const key = `${record.category}:${record.key.trim().toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => new Set(group.map((record) => record.value.trim())).size > 1).map((group) => {
    const ordered = [...group].sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
    return { key: ordered[0]!.key, category: ordered[0]!.category, records: ordered.map((record) => ({ id: record.id, value: record.value, confidence: record.confidence, source: record.source, updatedAt: record.updatedAt, status: record.status })), recommendedId: ordered[0]?.id, reason: "Multiple active values exist; prefer the highest-confidence freshest source and request owner confirmation before making an irreversible decision." };
  });
}

export function memoryEvidenceQuality(record: Pick<MemoryRecord, "source" | "confidence" | "updatedAt" | "reviewAt" | "expiresAt">, now = Date.now()): "strong" | "review_due" | "expired" | "weak" {
  if (record.expiresAt !== undefined && record.expiresAt <= now) return "expired";
  if (record.reviewAt !== undefined && record.reviewAt <= now) return "review_due";
  if (record.confidence >= 0.8 && Boolean(record.source)) return "strong";
  return "weak";
}
