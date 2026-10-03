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
