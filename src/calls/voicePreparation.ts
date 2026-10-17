type CacheEntry<T> = { value: T; expiresAt: number };

const ACCOUNT_TTL_MS = 30_000;
const TOOL_SCHEMA_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

const accountCache = new Map<string, CacheEntry<any>>();
const toolSchemaCache = new Map<string, CacheEntry<any[]>>();

function read<T>(cache: Map<string, CacheEntry<T>>, key: string, now = Date.now()): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}
function write<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number, now = Date.now()): T {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/** Cache only per-owner, per-call preparation; provider results are never cached here. */
export async function cachedVoiceConnectedAccounts<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = read<T>(accountCache, key);
  if (cached !== undefined) return cached;
  return write(accountCache, key, await load(), ACCOUNT_TTL_MS);
}

/** Reuse immutable Composio schemas during one call without reusing tool results. */
export async function cachedVoiceToolSchemas(key: string, load: () => Promise<any[]>): Promise<any[]> {
  const cached = read(toolSchemaCache, key);
  if (cached) return cached;
  const loaded = await load();
  return write(toolSchemaCache, key, loaded, TOOL_SCHEMA_TTL_MS);
}

export function clearVoicePreparationCache(): void {
  accountCache.clear();
  toolSchemaCache.clear();
}
