import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { config } from "../config.js";
import { createRedisClient } from "../redisClient.js";
import type { MemoryBrief, MemoryPurpose } from "./types.js";

let client: Redis | undefined;
function redis(): Redis | undefined {
  if (!config.redisUrl) return undefined;
  if (!client) client = createRedisClient(config.redisUrl, "cache", { lazyConnect: false });
  return client;
}
function key(input: { ownerUserId: number; purpose: MemoryPurpose; query: string; scopeIds: string[]; includeSensitive?: boolean; limit?: number }): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `chuck:memory:brief:${input.ownerUserId}:${digest}`;
}

/** Redis contains only a bounded, disposable purpose-specific projection. */
export async function getHotMemoryBrief(input: { ownerUserId: number; purpose: MemoryPurpose; query: string; scopeIds: string[]; includeSensitive?: boolean; limit?: number }): Promise<MemoryBrief | undefined> {
  const r = redis();
  if (!r) return undefined;
  try { const raw = await r.get(key(input)); return raw ? JSON.parse(raw) as MemoryBrief : undefined; } catch { return undefined; }
}

export async function setHotMemoryBrief(input: { ownerUserId: number; purpose: MemoryPurpose; query: string; scopeIds: string[]; includeSensitive?: boolean; limit?: number }, brief: MemoryBrief, ttlSeconds = 90): Promise<void> {
  const r = redis();
  if (!r) return;
  try { await r.setex(key(input), Math.max(15, Math.min(900, ttlSeconds)), JSON.stringify(brief)); } catch { /* cache failure never blocks durable memory */ }
}

export async function invalidateHotMemoryBriefs(ownerUserId: number): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const result = await r.scan(cursor, "MATCH", `chuck:memory:brief:${ownerUserId}:*`, "COUNT", 100);
      cursor = result[0]; keys.push(...result[1]);
    } while (cursor !== "0" && keys.length < 500);
    if (keys.length) await r.del(...keys.slice(0, 500));
  } catch { /* cache failure never blocks durable memory */ }
}
