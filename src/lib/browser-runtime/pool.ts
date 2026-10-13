import type { BrowserProviderId, BrowserSessionState } from "./types.js";

/** Owner-scoped concurrency guard for browser sessions. It never shares profiles across owners. */
export class BrowserSessionPool {
  private readonly active = new Map<number, number>();
  constructor(private readonly defaultLimit = 2) {}

  acquire(ownerId: number, limit = this.defaultLimit): { release: () => void; active: number; limit: number } {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error("Browser owner id is invalid");
    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const current = this.active.get(ownerId) ?? 0;
    if (current >= safeLimit) throw new Error("Browser session concurrency limit reached for this owner");
    this.active.set(ownerId, current + 1);
    let released = false;
    return { active: current + 1, limit: safeLimit, release: () => { if (!released) { released = true; const next = (this.active.get(ownerId) ?? 1) - 1; if (next > 0) this.active.set(ownerId, next); else this.active.delete(ownerId); } } };
  }

  activeFor(ownerId: number): number { return this.active.get(ownerId) ?? 0; }
}

export type WarmBrowserSession = {
  id: string;
  ownerId: number;
  provider: BrowserProviderId;
  region: string;
  profileId: string;
  state: BrowserSessionState;
  capabilities: string[];
  createdAt: number;
  lastUsedAt: number;
  leaseId?: string;
};

export type WarmPoolRequest = {
  ownerId: number;
  provider?: BrowserProviderId;
  region?: string;
  allowedRegions?: string[];
  profileId?: string;
  capabilities?: string[];
};

/**
 * A bounded warm-session registry. Providers own the actual browser process;
 * this registry only owns scheduling metadata and opaque session identities.
 * That boundary keeps a raw CDP endpoint out of pool state and makes the pool
 * usable with E2B, Kernel, or a self-hosted Playwright adapter.
 */
export class WarmBrowserSessionPool {
  private readonly sessions = new Map<string, WarmBrowserSession>();

  constructor(private readonly maxSessionsPerOwner = 4, private readonly now: () => number = Date.now) {}

  put(session: WarmBrowserSession): void {
    if (!Number.isSafeInteger(session.ownerId) || session.ownerId < 1) throw new Error("Warm browser owner id is invalid");
    if (!session.id || !session.profileId || !session.region) throw new Error("Warm browser session identity is incomplete");
    if (session.state === "terminated" || session.state === "expired") return;
    const ownerSessions = [...this.sessions.values()].filter((item) => item.ownerId === session.ownerId && item.id !== session.id);
    if (ownerSessions.length >= Math.max(1, Math.min(20, Math.trunc(this.maxSessionsPerOwner)))) {
      const evictable = ownerSessions.filter((item) => !item.leaseId).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!evictable) throw new Error("Warm browser pool is full for this owner");
      this.sessions.delete(evictable.id);
    }
    this.sessions.set(session.id, { ...session, capabilities: [...new Set(session.capabilities)].slice(0, 50) });
  }

  checkout(request: WarmPoolRequest): WarmBrowserSession | undefined {
    const allowed = new Set((request.allowedRegions ?? []).filter(Boolean));
    const wanted = new Set((request.capabilities ?? []).filter(Boolean));
    const candidates = [...this.sessions.values()].filter((session) => {
      if (session.ownerId !== request.ownerId || session.leaseId || !["warming", "ready", "paused"].includes(session.state)) return false;
      if (request.provider && session.provider !== request.provider) return false;
      if (request.region && session.region !== request.region) return false;
      if (allowed.size && !allowed.has(session.region)) return false;
      if (request.profileId && session.profileId !== request.profileId) return false;
      return [...wanted].every((capability) => session.capabilities.includes(capability));
    });
    candidates.sort((a, b) => {
      const regionScore = (item: WarmBrowserSession) => request.region && item.region === request.region ? 0 : request.allowedRegions?.indexOf(item.region) ?? 999;
      return regionScore(a) - regionScore(b) || a.lastUsedAt - b.lastUsedAt;
    });
    const selected = candidates[0];
    if (!selected) return undefined;
    selected.state = "active";
    selected.lastUsedAt = this.now();
    return { ...selected, capabilities: [...selected.capabilities] };
  }

  release(id: string, state: BrowserSessionState = "ready"): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.leaseId = undefined;
    session.state = state;
    session.lastUsedAt = this.now();
  }

  lease(id: string, leaseId: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Warm browser session not found");
    if (session.leaseId && session.leaseId !== leaseId) throw new Error("Warm browser session is already leased");
    session.leaseId = leaseId;
    session.state = "active";
    session.lastUsedAt = this.now();
  }

  remove(id: string): void { this.sessions.delete(id); }
  get(id: string): WarmBrowserSession | undefined { const value = this.sessions.get(id); return value ? { ...value, capabilities: [...value.capabilities] } : undefined; }
  list(ownerId: number): WarmBrowserSession[] { return [...this.sessions.values()].filter((item) => item.ownerId === ownerId).map((item) => ({ ...item, capabilities: [...item.capabilities] })); }
  size(ownerId?: number): number { return ownerId === undefined ? this.sessions.size : this.list(ownerId).length; }
}
