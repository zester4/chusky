import { createHash } from "node:crypto";

export type BrowserRef = { ref: string; ownerId: number; leaseId?: string; nodeId: string; observationId: string; pageGeneration: number; url?: string; issuedAt: number; expiresAt: number };
export type BrowserRefState = { observationId?: string; pageGeneration?: number; url?: string };

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }

/** Ephemeral refs make stale DOM targets fail closed after navigation/re-render. */
export class BrowserRefRegistry {
  private readonly refs = new Map<string, BrowserRef>();
  constructor(private readonly ttlMs = 120_000, private readonly now: () => number = Date.now) {}

  issue(input: { ownerId: number; leaseId?: string; nodeId: string; observationId: string; pageGeneration: number; url?: string }): BrowserRef {
    if (!Number.isSafeInteger(input.ownerId) || input.ownerId < 1 || !input.nodeId || !input.observationId || !Number.isSafeInteger(input.pageGeneration) || input.pageGeneration < 0) throw new Error("Browser ref identity is invalid");
    const issuedAt = this.now();
    const ref: BrowserRef = { ref: `ref_${hash(`${input.ownerId}:${input.leaseId ?? ""}:${input.nodeId}:${input.observationId}:${issuedAt}:${Math.random()}`)}`, ...input, issuedAt, expiresAt: issuedAt + Math.max(1_000, Math.min(10 * 60_000, this.ttlMs)) };
    this.refs.set(ref.ref, ref);
    return { ...ref };
  }

  assertFresh(refId: string, ownerId: number, state: BrowserRefState, leaseId?: string): BrowserRef {
    const ref = this.refs.get(refId);
    if (!ref || ref.ownerId !== ownerId || (ref.leaseId ?? undefined) !== (leaseId ?? undefined) || ref.expiresAt <= this.now()) throw new Error("Browser ref is expired or not owned by this session; re-observe the page");
    if (state.observationId !== ref.observationId || state.pageGeneration !== ref.pageGeneration || ref.url !== undefined && state.url !== undefined && ref.url !== state.url) throw new Error("Browser ref is stale after navigation or DOM changes; re-observe the page");
    return { ...ref };
  }

  invalidateForObservation(ownerId: number, leaseId: string | undefined, state: BrowserRefState): number {
    let removed = 0;
    for (const [key, ref] of this.refs) {
      if (ref.ownerId !== ownerId || (ref.leaseId ?? undefined) !== (leaseId ?? undefined)) continue;
      if ((state.observationId !== undefined && ref.observationId !== state.observationId) || (state.pageGeneration !== undefined && ref.pageGeneration !== state.pageGeneration) || (state.url !== undefined && ref.url !== undefined && ref.url !== state.url) || (state.url !== undefined && ref.expiresAt <= this.now())) { this.refs.delete(key); removed += 1; }
    }
    return removed;
  }

  invalidateOwner(ownerId: number): void { for (const [key, ref] of this.refs) if (ref.ownerId === ownerId) this.refs.delete(key); }
  size(): number { return this.refs.size; }
}

export const browserRefs = new BrowserRefRegistry();
