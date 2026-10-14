import { createHash } from "node:crypto";
import { config } from "../../config.js";
import { webBotAuthConfigurationStatus, webBotAuthKeyId, type WebBotAuthStatus } from "../../webBotAuth.js";
import { browserSiteCapabilities, normalizeBrowserOrigin, type BrowserRoute, type SiteCapability, type SiteCapabilityRegistry } from "./siteCapabilities.js";

export type BrowserTrustSignal = "challenge" | "access_denied" | "rate_limited" | "login_rejected" | "network_blocked" | "unknown";
export type BrowserTrustCircuitState = "closed" | "open";

export type BrowserTrustDecision = {
  origin: string;
  route: BrowserRoute;
  provider: "e2b" | "kernel" | "dedicated";
  identityKey: string;
  region: string;
  circuit: BrowserTrustCircuitState;
  capability: SiteCapability;
  identity: {
    profile: "stable-owner-origin";
    webBotAuth: WebBotAuthStatus;
    egress: "provider-managed" | "kernel-proxy-configured" | "direct-or-provider-default";
  };
  reason: string;
};

export type BrowserTrustOutcome = {
  url: string;
  signal?: BrowserTrustSignal;
  challenge?: boolean;
  needsUserInteraction?: boolean;
  verifiedHuman?: boolean;
  terminalStatus?: "success" | "solved" | "failure" | "timeout" | "abandoned" | "handoff";
};

type TrustRecord = {
  strikes: number;
  lastSignal?: BrowserTrustSignal;
  lastSignalAt?: number;
  openUntil?: number;
  successes: number;
};

function validOwner(ownerId: number): void {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error("Browser trust owner id is invalid");
}

function provider(): BrowserTrustDecision["provider"] {
  if (config.browserRuntimeEnabled) return "dedicated";
  return config.browserProvider === "kernel" ? "kernel" : "e2b";
}

function trustMode(): "strict" | "balanced" {
  return config.browserTrustMode;
}

export function stableBrowserIdentityKey(ownerId: number, origin: string): string {
  validOwner(ownerId);
  const canonicalOrigin = normalizeBrowserOrigin(origin);
  return `bi_${createHash("sha256").update(`${config.browserOperatorId}\0${ownerId}\0${canonicalOrigin}`).digest("hex").slice(0, 32)}`;
}

export class BrowserTrustLedger {
  private readonly records = new Map<string, TrustRecord>();

  constructor(private readonly options: { threshold?: number; cooldownMs?: number; now?: () => number; maxRecords?: number } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private threshold(): number { return this.options.threshold ?? config.browserFlagThreshold; }
  private cooldownMs(): number { return this.options.cooldownMs ?? config.browserFlagCooldownMs; }
  private key(ownerId: number, origin: string): string { return `${ownerId}:${normalizeBrowserOrigin(origin)}`; }

  status(ownerId: number, origin: string): { state: BrowserTrustCircuitState; strikes: number; threshold: number; retryAfterMs: number; lastSignal?: BrowserTrustSignal } {
    validOwner(ownerId);
    const record = this.records.get(this.key(ownerId, origin));
    const retryAfterMs = Math.max(0, (record?.openUntil ?? 0) - this.now());
    if (retryAfterMs === 0 && record?.openUntil) record.openUntil = undefined;
    return { state: retryAfterMs > 0 ? "open" : "closed", strikes: record?.strikes ?? 0, threshold: this.threshold(), retryAfterMs, ...(record?.lastSignal ? { lastSignal: record.lastSignal } : {}) };
  }

  recordSignal(ownerId: number, origin: string, signal: BrowserTrustSignal): ReturnType<BrowserTrustLedger["status"]> {
    validOwner(ownerId);
    const key = this.key(ownerId, origin);
    const current = this.records.get(key) ?? { strikes: 0, successes: 0 };
    current.strikes = Math.min(this.threshold(), current.strikes + 1);
    current.lastSignal = signal;
    current.lastSignalAt = this.now();
    if (current.strikes >= this.threshold()) current.openUntil = this.now() + this.cooldownMs();
    this.records.set(key, current);
    const maxRecords = this.options.maxRecords ?? 2_000;
    while (this.records.size > maxRecords) this.records.delete(this.records.keys().next().value as string);
    return this.status(ownerId, origin);
  }

  recordSuccess(ownerId: number, origin: string): void {
    validOwner(ownerId);
    const key = this.key(ownerId, origin);
    const current = this.records.get(key) ?? { strikes: 0, successes: 0 };
    current.successes = Math.min(1_000, current.successes + 1);
    this.records.set(key, current);
  }

  clearAfterVerifiedHuman(ownerId: number, origin: string): void {
    validOwner(ownerId);
    this.records.delete(this.key(ownerId, origin));
  }

  snapshot(): Array<{ ownerFingerprint: string; origin: string; strikes: number; state: BrowserTrustCircuitState; lastSignal?: BrowserTrustSignal }> {
    return [...this.records.entries()].map(([key, record]) => {
      const separator = key.indexOf(":");
      const owner = key.slice(0, separator);
      const origin = key.slice(separator + 1);
      return { ownerFingerprint: createHash("sha256").update(owner).digest("hex").slice(0, 12), origin, strikes: record.strikes, state: this.status(Number(owner), origin).state, ...(record.lastSignal ? { lastSignal: record.lastSignal } : {}) };
    });
  }
}

function egressMode(): BrowserTrustDecision["identity"]["egress"] {
  if (config.browserProvider === "kernel" && config.kernelProxyId) return "kernel-proxy-configured";
  if (config.browserProvider === "kernel") return "provider-managed";
  return "direct-or-provider-default";
}

export class BrowserTrustRouter {
  constructor(private readonly registry: SiteCapabilityRegistry = browserSiteCapabilities, private readonly ledger = new BrowserTrustLedger()) {}

  beforeNavigation(input: { ownerId: number; url: string; ownerPrivateRun?: boolean }): BrowserTrustDecision {
    validOwner(input.ownerId);
    const origin = normalizeBrowserOrigin(input.url);
    const capability = this.registry.resolve(input.url);
    const circuit = this.ledger.status(input.ownerId, origin);
    const identityKey = stableBrowserIdentityKey(input.ownerId, origin);
    const identityStatus = webBotAuthConfigurationStatus();
    if (circuit.state === "open") {
      const route: BrowserRoute = input.ownerPrivateRun ? "human-handoff" : "blocked";
      return {
        origin, route, provider: provider(), identityKey, region: config.browserDefaultRegion, circuit: circuit.state, capability,
        identity: { profile: "stable-owner-origin", webBotAuth: identityStatus, egress: egressMode() },
        reason: input.ownerPrivateRun
          ? "Repeated challenge or access signals opened a circuit. Pause and use the private same-session human handoff before retrying."
          : "Repeated challenge or access signals opened a circuit. This run cannot retry automatically outside the owner's private conversation.",
      };
    }
    const route = capability.preferred;
    const reason = trustMode() === "strict" && identityStatus === "misconfigured"
      ? "The browser identity configuration is incomplete; continue only through the headed browser and expect a human handoff if the site challenges the session."
      : capability.reason ?? "Use the selected site route.";
    return {
      origin, route, provider: provider(), identityKey, region: config.browserDefaultRegion, circuit: circuit.state, capability,
      identity: { profile: "stable-owner-origin", webBotAuth: identityStatus, egress: egressMode() }, reason,
    };
  }

  recordOutcome(ownerId: number, outcome: BrowserTrustOutcome): void {
    const origin = normalizeBrowserOrigin(outcome.url);
    if (outcome.verifiedHuman || outcome.terminalStatus === "solved" || outcome.terminalStatus === "handoff") {
      this.ledger.clearAfterVerifiedHuman(ownerId, origin);
      return;
    }
    const signal = outcome.signal ?? (outcome.challenge || outcome.needsUserInteraction ? "challenge" : undefined);
    if (signal) this.ledger.recordSignal(ownerId, origin, signal);
    else if (outcome.terminalStatus === "success") this.ledger.recordSuccess(ownerId, origin);
  }

  clearAfterVerifiedHuman(ownerId: number, url: string): void {
    this.ledger.clearAfterVerifiedHuman(ownerId, normalizeBrowserOrigin(url));
  }

  status(ownerId: number, url: string): ReturnType<BrowserTrustLedger["status"]> {
    return this.ledger.status(ownerId, normalizeBrowserOrigin(url));
  }

  readiness(): {
    mode: "strict" | "balanced";
    provider: BrowserTrustDecision["provider"];
    defaultRegion: string;
    stableOwnerOriginProfiles: true;
    webBotAuth: WebBotAuthStatus;
    webBotAuthKeyId?: string;
    ownerChrome: { enabled: boolean; adapter: "not-configured" };
  } {
    const status = webBotAuthConfigurationStatus();
    return {
      mode: trustMode(), provider: provider(), defaultRegion: config.browserDefaultRegion,
      stableOwnerOriginProfiles: true, webBotAuth: status, ...(status === "configured" && webBotAuthKeyId() ? { webBotAuthKeyId: webBotAuthKeyId() } : {}),
      ownerChrome: { enabled: config.browserOwnerChromeEnabled, adapter: "not-configured" },
    };
  }

  getTrustLedger(): BrowserTrustLedger { return this.ledger; }
}

export const browserTrustRouter = new BrowserTrustRouter();
