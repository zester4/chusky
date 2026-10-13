import { randomUUID } from "node:crypto";
import { evaluateBrowserAction } from "./actionPolicy.js";
import { browserCdpBroker, type CdpSessionBroker } from "./broker.js";
import { browserMetrics } from "./metrics.js";
import { BrowserSessionPool, WarmBrowserSessionPool, type WarmBrowserSession } from "./pool.js";
import type { BrowserProviderId, BrowserSessionManagerContract, BrowserSessionRequest, BrowserSessionView, BrowserSessionActionContext, BrowserSessionState } from "./types.js";

export type ProviderSession = { backendId: string; provider: BrowserProviderId; region: string; profileId: string; capabilities: string[]; reconnectable: boolean; cdpUrl?: string; state?: BrowserSessionState };
export type BrowserProviderAdapter = {
  provider: BrowserProviderId;
  regions: string[];
  acquire(request: BrowserSessionRequest & { region: string; profileId: string }): Promise<ProviderSession>;
  reconnect(session: ProviderSession): Promise<ProviderSession>;
  renew(session: ProviderSession, expiresAt: number): Promise<void>;
  release(session: ProviderSession): Promise<void>;
};

type ManagedLease = { ownerId: number; view: BrowserSessionView; providerSession: ProviderSession; adapter?: BrowserProviderAdapter; warmId?: string; releaseSlot?: () => void };

function validOwner(ownerId: number): void { if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error("Browser owner id is invalid"); }
function leaseId(): string { return `br_${randomUUID()}`; }
function profileId(ownerId: number, requested?: string): string { validOwner(ownerId); if (requested && /^[A-Za-z0-9_-]{8,160}$/.test(requested)) return requested; return `bp_${ownerId}_${randomUUID().replaceAll("-", "").slice(0, 24)}`; }

/** Provider-neutral browser control plane. Providers remain responsible for starting Chromium. */
export class BrowserSessionManager implements BrowserSessionManagerContract {
  private readonly adapters = new Map<BrowserProviderId, BrowserProviderAdapter>();
  private readonly leases = new Map<string, ManagedLease>();
  private readonly profileOwners = new Map<string, number>();
  private readonly ownerPool: BrowserSessionPool;
  private readonly warmPool: WarmBrowserSessionPool;

  constructor(private readonly options: { maxSessionsPerOwner?: number; maxWarmSessionsPerOwner?: number; defaultLeaseTtlMs?: number; broker?: CdpSessionBroker; now?: () => number } = {}) {
    this.ownerPool = new BrowserSessionPool(options.maxSessionsPerOwner ?? 2);
    this.warmPool = new WarmBrowserSessionPool(options.maxWarmSessionsPerOwner ?? 4, options.now ?? Date.now);
  }

  register(adapter: BrowserProviderAdapter): void { if (!adapter.provider || !adapter.regions.length) throw new Error("Browser provider adapter must declare a provider and region"); this.adapters.set(adapter.provider, adapter); }

  private chooseProvider(request: BrowserSessionRequest): BrowserProviderAdapter {
    if (request.preferredProvider) { const selected = this.adapters.get(request.preferredProvider); if (selected) return selected; }
    const selected = [...this.adapters.values()].find((adapter) => (request.allowedRegions ?? []).length === 0 || adapter.regions.some((region) => request.allowedRegions!.includes(region)));
    if (!selected) throw new Error("No browser provider is available for this session request");
    return selected;
  }

  private chooseRegion(adapter: BrowserProviderAdapter, request: BrowserSessionRequest): string {
    const allowed = request.allowedRegions?.length ? request.allowedRegions.filter((region) => adapter.regions.includes(region)) : adapter.regions;
    const region = request.preferredRegion && allowed.includes(request.preferredRegion) ? request.preferredRegion : allowed[0];
    if (!region) throw new Error("No browser region is available for this session request");
    return region;
  }

  private claimProfile(ownerId: number, provider: BrowserProviderId, profileId: string): void {
    const key = `${provider}:${profileId}`; const current = this.profileOwners.get(key);
    if (current !== undefined && current !== ownerId) throw new Error("Browser profile is already owned by another account");
    this.profileOwners.set(key, ownerId);
  }

  async acquire(request: BrowserSessionRequest): Promise<BrowserSessionView> {
    validOwner(request.ownerId);
    const slot = this.ownerPool.acquire(request.ownerId);
    const startedAt = Date.now();
    let checkedOutWarmId: string | undefined;
    try {
      const adapter = this.chooseProvider(request); const region = this.chooseRegion(adapter, request); const profile = profileId(request.ownerId, request.profileId); this.claimProfile(request.ownerId, adapter.provider, profile); const id = leaseId();
      const warm = this.warmPool.checkout({ ownerId: request.ownerId, provider: adapter.provider, region, allowedRegions: request.allowedRegions, profileId: request.profileId, capabilities: request.capabilities });
      const providerSession = warm ? { backendId: warm.id, provider: warm.provider, region: warm.region, profileId: warm.profileId, capabilities: warm.capabilities, reconnectable: true, state: "active" as const } : await adapter.acquire({ ...request, region, profileId: profile });
      if (warm) { checkedOutWarmId = warm.id; this.warmPool.lease(warm.id, id); }
      const ttl = Math.max(10_000, Math.min(60 * 60_000, Math.trunc(request.leaseTtlMs ?? this.options.defaultLeaseTtlMs ?? 15 * 60_000))); const expiresAt = (this.options.now ?? Date.now)() + ttl;
      await adapter.renew(providerSession, expiresAt);
      const ticket = providerSession.cdpUrl ? (this.options.broker ?? browserCdpBroker).issue({ ownerId: request.ownerId, leaseId: id, provider: providerSession.provider, cdpUrl: providerSession.cdpUrl, ttlMs: ttl }).ticket : undefined;
      const view: BrowserSessionView = { leaseId: id, provider: providerSession.provider, region: providerSession.region, profileId: providerSession.profileId, state: "active", issuedAt: (this.options.now ?? Date.now)(), expiresAt, reconnectable: providerSession.reconnectable, capabilities: [...providerSession.capabilities], ...(ticket ? { cdpBrokerTicket: ticket } : {}) };
      this.leases.set(id, { ownerId: request.ownerId, view, providerSession, adapter, releaseSlot: slot.release, ...(warm ? { warmId: warm.id } : {}) });
      browserMetrics.record({ kind: "attach", provider: view.provider, status: "success", durationMs: Date.now() - startedAt, ownerId: request.ownerId });
      return { ...view, capabilities: [...view.capabilities] };
    } catch (error) { if (checkedOutWarmId) this.warmPool.release(checkedOutWarmId); browserMetrics.record({ kind: "attach", provider: request.preferredProvider ?? "e2b", status: "failure", durationMs: Date.now() - startedAt, ownerId: request.ownerId }); slot.release(); throw error; }
  }

  assertLease(ownerId: number, id: string): BrowserSessionView {
    validOwner(ownerId); const lease = this.leases.get(id); if (!lease || lease.view.expiresAt <= (this.options.now ?? Date.now)()) throw new Error("Browser session lease is missing or expired");
    if (lease.view.leaseId !== id) throw new Error("Browser session lease identity mismatch");
    return { ...lease.view, capabilities: [...lease.view.capabilities] };
  }

  async renew(ownerId: number, id: string, ttlMs = this.options.defaultLeaseTtlMs ?? 15 * 60_000): Promise<BrowserSessionView> {
    const lease = this.leases.get(id); const current = this.assertLease(ownerId, id); const expiresAt = (this.options.now ?? Date.now)() + Math.max(10_000, Math.min(60 * 60_000, Math.trunc(ttlMs)));
    if (lease?.adapter) await lease.adapter.renew(lease.providerSession, expiresAt); lease!.view = { ...current, expiresAt }; return { ...lease!.view, capabilities: [...lease!.view.capabilities] };
  }

  async reconnect(ownerId: number, id: string): Promise<BrowserSessionView> {
    const lease = this.leases.get(id); this.assertLease(ownerId, id); if (!lease?.adapter || !lease.providerSession.reconnectable) throw new Error("Browser session cannot reconnect");
    const startedAt = Date.now(); lease.view = { ...lease.view, state: "reconnecting" };
    try { lease.providerSession = await lease.adapter.reconnect(lease.providerSession); lease.view = { ...lease.view, state: "active", region: lease.providerSession.region, profileId: lease.providerSession.profileId, capabilities: [...lease.providerSession.capabilities] }; browserMetrics.record({ kind: "reconnect", provider: lease.view.provider, status: "success", durationMs: Date.now() - startedAt, ownerId }); return { ...lease.view, capabilities: [...lease.view.capabilities] }; }
    catch (error) { lease.view = { ...lease.view, state: "paused" }; browserMetrics.record({ kind: "reconnect", provider: lease.view.provider, status: "failure", durationMs: Date.now() - startedAt, ownerId }); throw error; }
  }

  async release(ownerId: number, id: string): Promise<void> {
    const lease = this.leases.get(id); if (!lease) return;
    if (lease.ownerId !== ownerId) throw new Error("Browser session lease is not owned by this account");
    if (lease.view.expiresAt <= (this.options.now ?? Date.now)()) { this.leases.delete(id); this.warmPool.release(lease.warmId ?? lease.providerSession.backendId, "expired"); lease.releaseSlot?.(); return; }
    try { if (lease.adapter) await lease.adapter.release(lease.providerSession); } finally { this.leases.delete(id); this.warmPool.release(lease.warmId ?? lease.providerSession.backendId); lease.releaseSlot?.(); }
  }

  /** Bridge for a provider controller that already owns startup/shutdown. */
  adoptExternalLease(input: { ownerId: number; leaseId: string; provider: BrowserProviderId; backendId: string; region?: string; profileId: string; expiresAt: number; capabilities?: string[] }): BrowserSessionView {
    validOwner(input.ownerId);
    if (!/^br_[A-Za-z0-9_-]{8,160}$/.test(input.leaseId) || !input.backendId || !input.profileId || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= (this.options.now ?? Date.now)()) throw new Error("External browser lease is invalid");
    this.claimProfile(input.ownerId, input.provider, input.profileId);
    const view: BrowserSessionView = { leaseId: input.leaseId, provider: input.provider, region: input.region || "default", profileId: input.profileId, state: "active", issuedAt: (this.options.now ?? Date.now)(), expiresAt: input.expiresAt, reconnectable: true, capabilities: [...new Set(input.capabilities ?? ["headed", "reconnect"])].slice(0, 50) };
    this.leases.set(input.leaseId, { ownerId: input.ownerId, view, providerSession: { backendId: input.backendId, provider: input.provider, region: view.region, profileId: input.profileId, capabilities: view.capabilities, reconnectable: true } });
    return { ...view, capabilities: [...view.capabilities] };
  }

  unadoptExternalLease(ownerId: number, id: string): boolean {
    const lease = this.leases.get(id);
    if (!lease || lease.ownerId !== ownerId || lease.view.expiresAt <= (this.options.now ?? Date.now)()) return false;
    this.leases.delete(id); return true;
  }

  isTracked(ownerId: number, id: string): boolean {
    const lease = this.leases.get(id); return Boolean(lease && lease.ownerId === ownerId && lease.view.expiresAt > (this.options.now ?? Date.now)());
  }

  async execute<T>(context: BrowserSessionActionContext, operation: () => Promise<T>): Promise<T> {
    const view = this.assertLease(context.ownerId, context.leaseId); const policy = evaluateBrowserAction(context); if (policy.decision === "blocked" || policy.decision === "approval_required") throw new Error(policy.reason);
    const startedAt = Date.now();
    try { const result = await operation(); browserMetrics.record({ kind: "action", provider: view.provider, status: "success", action: context.action, durationMs: Date.now() - startedAt, ownerId: context.ownerId }); return result; }
    catch (error) { browserMetrics.record({ kind: "action", provider: view.provider, status: "failure", action: context.action, durationMs: Date.now() - startedAt, ownerId: context.ownerId }); throw error; }
  }

  /** Register a provider-created warm session without exposing its backend handle. */
  registerWarm(session: WarmBrowserSession): void { this.warmPool.put(session); }
  warmSessions(ownerId: number): WarmBrowserSession[] { return this.warmPool.list(ownerId); }
  activeFor(ownerId: number): number { return this.ownerPool.activeFor(ownerId); }
}

export const browserSessionManager = new BrowserSessionManager();
