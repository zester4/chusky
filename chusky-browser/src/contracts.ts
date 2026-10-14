export type ProviderId = "e2b" | "kernel" | "playwright-cdp" | "browser-harness" | "local";

export type BrowserCapability =
  | "structured-observation"
  | "accessibility-tree"
  | "screenshots"
  | "native-input"
  | "cdp"
  | "frames"
  | "profiles"
  | "managed-auth"
  | "live-view"
  | "replay"
  | "network-events"
  | "downloads"
  | "uploads";

export type SessionState = "starting" | "ready" | "waiting-challenge" | "handoff" | "stopping" | "stopped" | "failed";
export type ScreenshotMode = "none" | "thumbnail" | "viewport" | "region" | "full-page";
export type ScreenshotReason = "initial" | "after-action" | "changed" | "ambiguous" | "challenge" | "coordinate-action" | "user-request";
export type MutationClass = "read-only" | "idempotent" | "consequential";
export type RetryPolicy = "never" | "reobserve-only" | "reobserve-and-retry";

export type ControlTarget = {
  observationId: string;
  pageGeneration: number;
  frameIndex?: number;
  nodeId?: string;
  role?: string;
  name?: string;
  index?: number;
  stable?: Partial<Record<"id" | "nameAttr" | "placeholder" | "autocomplete", string>>;
  screenshotHash?: string;
};

export type BrowserControl = ControlTarget & {
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  selected?: string;
  bounds?: { x: number; y: number; width: number; height: number };
};

export type ChallengeSignal = {
  detected: boolean;
  kind?: "captcha" | "press-and-hold" | "cloudflare" | "mfa" | "passkey" | "age-check" | "unknown";
  status?: "waiting" | "cleared" | "failed" | "timeout" | "user-required";
  userRequired?: boolean;
};

export type ScreenshotEvidence = {
  mode: Exclude<ScreenshotMode, "none">;
  hash: string;
  width: number;
  height: number;
  capturedAt: number;
  reason: ScreenshotReason;
  redacted: boolean;
  artifactId?: string;
};

export type BrowserObservation = {
  observationId: string;
  pageGeneration: number;
  provider: ProviderId;
  url: string;
  title: string;
  origin: string;
  frameIndex: number;
  controls: BrowserControl[];
  accessibilityHash: string;
  screenshot?: ScreenshotEvidence;
  challenge?: ChallengeSignal;
  loadState?: "loading" | "domcontentloaded" | "networkidle" | "complete" | "unknown";
  tabCount: number;
  capturedAt: number;
};

export type BrowserAssertion =
  | { kind: "url-includes" | "title-includes" | "text-includes" | "download"; value: string; required?: boolean }
  | { kind: "page-changed" | "visible" | "checked"; value?: string | boolean; required?: boolean }
  | { kind: "control-value"; target: ControlTarget; value: string; required?: boolean };

export type BrowserAction = {
  id: string;
  kind: "navigate" | "click" | "fill" | "press" | "scroll" | "select" | "check" | "upload" | "wait" | "extract";
  mutation: MutationClass;
  retry: RetryPolicy;
  target?: ControlTarget;
  url?: string;
  value?: string;
  key?: string;
  delta?: { x?: number; y?: number };
  expected?: BrowserAssertion[];
  timeoutMs?: number;
};

export type ObservationRequest = {
  screenshot: ScreenshotMode;
  screenshotReason: ScreenshotReason;
  includeForms?: boolean;
  includeFrames?: boolean;
  includeNetwork?: boolean;
  maxControls?: number;
};

export type SessionHandle = {
  id: string;
  provider: ProviderId;
  ownerScope: string;
  origin?: string;
  state: SessionState;
  capabilities: ReadonlySet<BrowserCapability>;
  privateLiveViewUrl?: string;
};

export type ActionResult = {
  actionId: string;
  providerReceipt?: string;
  mutationObserved: "not-started" | "started" | "completed" | "unknown";
  observation?: BrowserObservation;
};

export type VerificationResult = {
  verified: boolean;
  checks: Array<{ kind: BrowserAssertion["kind"]; passed: boolean; evidence?: string }>;
};

export type ChallengeResult = {
  status: "cleared" | "failed" | "timeout" | "abandoned" | "user-required";
  observation?: BrowserObservation;
  liveViewUrl?: string;
  expiresAt?: number;
};

export type BrowserAdapter = {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<BrowserCapability>;
  start(input: { ownerScope: string; startUrl: string; profileId?: string; headful?: boolean }): Promise<SessionHandle>;
  observe(session: SessionHandle, request: ObservationRequest): Promise<BrowserObservation>;
  act(session: SessionHandle, action: BrowserAction): Promise<ActionResult>;
  verify(session: SessionHandle, assertions: BrowserAssertion[], before: BrowserObservation, after: BrowserObservation): Promise<VerificationResult>;
  waitForChallenge?(session: SessionHandle, timeoutMs: number): Promise<ChallengeResult>;
  handoff?(session: SessionHandle, reason: string): Promise<ChallengeResult>;
  stop(session: SessionHandle): Promise<void>;
};

export type BrowserPolicy = {
  allowedOrigins: string[];
  maxActions: number;
  maxDurationMs: number;
  noProgressLimit: number;
  defaultScreenshot: ScreenshotMode;
  requireHandoffForChallenges: boolean;
};

export type BrowserTask = {
  id: string;
  ownerScope: string;
  startUrl: string;
  actions: BrowserAction[];
  approvedActionIds?: string[];
  policy?: Partial<BrowserPolicy>;
};

export type BrowserTraceEvent = {
  id: string;
  taskId: string;
  sessionId?: string;
  phase: "start" | "observe" | "act" | "verify" | "recover" | "handoff" | "stop";
  actionId?: string;
  status: "started" | "succeeded" | "failed" | "waiting" | "replanned";
  provider?: ProviderId;
  urlOrigin?: string;
  pageGeneration?: number;
  accessibilityHash?: string;
  screenshotHash?: string;
  errorCode?: string;
  recovery?: string;
  createdAt: number;
};

export type BrowserRunResult = {
  taskId: string;
  status: "completed" | "blocked" | "failed" | "timed-out";
  verified: boolean;
  completedActions: string[];
  nextAction?: string;
  finalObservation?: BrowserObservation;
  events: BrowserTraceEvent[];
  reason?: string;
  challenge?: import("./challenge-manager.js").ChallengeOutcome;
  continuation?: { session: SessionHandle; challenge: import("./challenge-manager.js").ChallengeOutcome };
};
