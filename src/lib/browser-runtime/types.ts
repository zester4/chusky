/** Internal contracts for the E2B browser execution layer. Chusky owns policy. */
export type BrowserProvider = "e2b";

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
