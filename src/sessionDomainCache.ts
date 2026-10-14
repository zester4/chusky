import { DURABLE_SESSION_DOMAINS, type DurableSessionDocument, type DurableSessionDomain } from "./neonDurableState.js";

export const SESSION_DOMAIN_CACHE_TTL_SECONDS = 5 * 60;
export const MAX_SESSION_DOMAIN_CACHE_BYTES = 512 * 1024;

export type CachedSessionDomain = DurableSessionDocument;

export function sessionDomainCacheKey(userId: number, domain: DurableSessionDomain): string {
  return `chuck:session-domain:${userId}:${domain}`;
}

export function encodeSessionDomainCache(document: CachedSessionDomain): string | undefined {
  const encoded = JSON.stringify(document);
  return Buffer.byteLength(encoded, "utf8") <= MAX_SESSION_DOMAIN_CACHE_BYTES ? encoded : undefined;
}

export function parseSessionDomainCache(raw: string | null | undefined, expectedDomain: DurableSessionDomain): CachedSessionDomain | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CachedSessionDomain>;
    const version = value.version;
    if (value.domain !== expectedDomain || typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0 || !Object.hasOwn(value, "payload")) return undefined;
    const updatedAt = value.updatedAt;
    return { domain: expectedDomain, payload: value.payload, version, updatedAt: typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) ? updatedAt : Date.now() };
  } catch {
    return undefined;
  }
}

export function parseLegacySessionDomainCache(raw: string | null | undefined): Map<DurableSessionDomain, CachedSessionDomain> {
  if (!raw) return new Map();
  try {
    const value = JSON.parse(raw) as { documents?: unknown };
    if (!Array.isArray(value.documents)) return new Map();
    const documents = new Map<DurableSessionDomain, CachedSessionDomain>();
    for (const entry of value.documents) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [domain, document] = entry as [unknown, Partial<CachedSessionDomain>];
      if (typeof domain !== "string" || !DURABLE_SESSION_DOMAINS.includes(domain as DurableSessionDomain)) continue;
      const version = document?.version;
      if (document?.domain !== domain || typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0 || !Object.hasOwn(document, "payload")) continue;
      const updatedAt = document.updatedAt;
      documents.set(domain as DurableSessionDomain, { domain: domain as DurableSessionDomain, payload: document.payload, version, updatedAt: typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) ? updatedAt : Date.now() });
    }
    return documents;
  } catch {
    return new Map();
  }
}
