/** Internal contracts for the E2B browser execution layer. Chusky owns policy. */
export type BrowserProvider = "e2b";

/** Provider identities are deliberately broader than the current default.
 * The E2B controller may host Kernel Chromium or local Agent Browser, while
 * callers still use one provider-neutral session contract. */
export type BrowserProviderId = "e2b" | "kernel" | "playwright" | "agent-browser";

export type BrowserSessionState = "warming" | "ready" | "active" | "paused" | "reconnecting" | "expired" | "terminated";

export type BrowserSessionRequest = {
  ownerId: number;
  preferredProvider?: BrowserProviderId;
  preferredRegion?: string;
  allowedRegions?: string[];
  profileId?: string;
  persistent?: boolean;
  leaseTtlMs?: number;
  capabilities?: string[];
};

export type BrowserSessionView = {
  leaseId: string;
  provider: BrowserProviderId;
  region: string;
  profileId: string;
  state: BrowserSessionState;
  issuedAt: number;
  expiresAt: number;
  reconnectable: boolean;
  capabilities: string[];
  /** Opaque viewer/broker reference. It is never a raw CDP or provider URL. */
  cdpBrokerTicket?: string;
};

export type BrowserSessionActionContext = {
  ownerId: number;
  leaseId: string;
  action: string;
  targetLabel?: string;
  targetUrl?: string;
  ownerPrivateRun?: boolean;
  ownerApprovedAction?: boolean;
  vaultAction?: string;
};

export interface BrowserSessionManagerContract {
  acquire(request: BrowserSessionRequest): Promise<BrowserSessionView>;
  renew(ownerId: number, leaseId: string, ttlMs?: number): Promise<BrowserSessionView>;
  reconnect(ownerId: number, leaseId: string): Promise<BrowserSessionView>;
  release(ownerId: number, leaseId: string): Promise<void>;
  assertLease(ownerId: number, leaseId: string): BrowserSessionView;
  execute<T>(context: BrowserSessionActionContext, operation: () => Promise<T>): Promise<T>;
}

export type BrowserProfile = {
  id: string;
  ownerId: number;
  provider: BrowserProvider;
  origin?: string;
  locale?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  persistent: boolean;
  maxConcurrentSessions: number;
};

export type BrowserObservation = {
  provider: BrowserProvider;
  url?: string;
  title?: string;
  pageGeneration?: number;
  observationId?: string;
  screenshotHash?: string;
  screenshot?: string;
  nodes: Array<{ role: string; name: string; index: number; frameIndex?: number; nodeId?: string }>;
  forms?: unknown[];
  capturedAt: number;
};

export type BrowserActionStep = {
  id?: string;
  action: string;
  selector?: Record<string, unknown>;
  value?: string;
  text?: string;
  screenshotHash?: string;
  visualFallback?: boolean;
  expected?: BrowserAssertion[];
};

export type BrowserAssertion = {
  kind: "url" | "title" | "text" | "field" | "checked" | "selected" | "visible";
  value: string;
  equals?: string | boolean;
  required?: boolean;
};

export type BrowserTraceEvent = {
  id: string;
  ownerId: number;
  sessionId?: string;
  provider: BrowserProvider;
  phase: "observe" | "act" | "extract" | "verify" | "repair" | "handoff";
  action?: string;
  status: "started" | "succeeded" | "failed" | "replanned";
  target?: { role?: string; name?: string; frameIndex?: number };
  observationId?: string;
  screenshotHash?: string;
  errorCode?: string;
  createdAt: number;
};

export interface BrowserRuntime {
  readonly provider: BrowserProvider;
  observe(ownerId: number, options?: { screenshot?: boolean; includeForms?: boolean }): Promise<BrowserObservation>;
  act(ownerId: number, step: BrowserActionStep): Promise<Record<string, unknown>>;
  extract(ownerId: number, schema: Record<string, unknown>): Promise<Record<string, unknown>>;
  run(ownerId: number, steps: BrowserActionStep[], options?: { maxSteps?: number; maxActions?: number; maxDurationMs?: number; noProgressLimit?: number; completionAssertions?: BrowserAssertion[] }): Promise<Record<string, unknown>>;
}
