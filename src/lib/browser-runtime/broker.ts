import { createHash, randomBytes } from "node:crypto";
import type { BrowserProviderId } from "./types.js";

type BrokerEntry = { ownerId: number; leaseId: string; provider: BrowserProviderId; cdpUrl: string; expiresAt: number };

export type CdpBrokerView = { ticket: string; provider: BrowserProviderId; leaseId: string; expiresAt: number };

function validCdpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && !url.username && !url.password && url.hostname.length > 0;
  } catch { return false; }
}

/**
 * Keeps provider CDP URLs in trusted process memory and gives callers only an
 * opaque, owner-bound ticket. `resolveInternal` is intentionally named and
 * scoped for provider adapters; it must never be included in tool responses.
 */
export class CdpSessionBroker {
  private readonly entries = new Map<string, BrokerEntry>();
  constructor(private readonly defaultTtlMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  issue(input: { ownerId: number; leaseId: string; provider: BrowserProviderId; cdpUrl: string; ttlMs?: number }): CdpBrokerView {
    if (!Number.isSafeInteger(input.ownerId) || input.ownerId < 1) throw new Error("CDP broker owner is invalid");
    if (!/^br_[A-Za-z0-9_-]{8,160}$/.test(input.leaseId)) throw new Error("CDP broker lease is invalid");
    if (!validCdpUrl(input.cdpUrl)) throw new Error("CDP broker received an invalid WebSocket URL");
    const ticket = `cdp_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + Math.max(10_000, Math.min(15 * 60_000, Math.trunc(input.ttlMs ?? this.defaultTtlMs)));
    this.entries.set(createHash("sha256").update(ticket).digest("hex"), { ownerId: input.ownerId, leaseId: input.leaseId, provider: input.provider, cdpUrl: input.cdpUrl, expiresAt });
    return { ticket, provider: input.provider, leaseId: input.leaseId, expiresAt };
  }

  resolveInternal(ticket: string, ownerId: number, leaseId: string): string | undefined {
    const entry = this.entries.get(createHash("sha256").update(String(ticket)).digest("hex"));
    if (!entry || entry.expiresAt <= this.now() || entry.ownerId !== ownerId || entry.leaseId !== leaseId) return undefined;
    return entry.cdpUrl;
  }

  revoke(ticket: string, ownerId: number): boolean {
    const key = createHash("sha256").update(String(ticket)).digest("hex");
    const entry = this.entries.get(key);
    if (!entry || entry.ownerId !== ownerId) return false;
    this.entries.delete(key);
    return true;
  }

  sweep(): number {
    const now = this.now(); let removed = 0;
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) { this.entries.delete(key); removed += 1; }
    return removed;
  }
}

export const browserCdpBroker = new CdpSessionBroker();
