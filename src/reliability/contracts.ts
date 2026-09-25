/** Shared reliability contracts used by missions, autonomy, operators, and the SDK. */

export type ReliabilityStatus = "verified" | "failed" | "uncertain" | "blocked";

export type OutcomeCheckKind = "provider_read" | "receipt" | "artifact" | "human";

export interface OutcomeCheck {
  id: string;
  kind: OutcomeCheckKind;
  description: string;
  provider?: string;
  toolSlug?: string;
  /** A provider read result must be no older than this many milliseconds. */
  freshnessMs?: number;
  required?: boolean;
  expected?: Record<string, unknown>;
}

export interface OutcomeCheckResult {
  checkId: string;
  status: "passed" | "failed" | "uncertain" | "skipped";
  observed?: Record<string, unknown>;
  evidenceRef?: string;
  observedAt?: number;
  reason?: string;
}

export interface OutcomeVerification {
  id: string;
  ownerId: number;
  missionId?: string;
  runId?: string;
  status: ReliabilityStatus;
  checks: OutcomeCheck[];
  results: OutcomeCheckResult[];
  confidence: number;
  unresolved: string[];
  startedAt: number;
  completedAt?: number;
  nextCheckAt?: number;
  version: number;
}

export type CompensationStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

export interface CompensationRecord {
  id: string;
  ownerId: number;
  missionId?: string;
  missionStepId?: string;
  originalActionId: string;
  provider: string;
  objective: string;
  status: CompensationStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  error?: string;
  approvalId?: string;
}

export type TraceEventKind =
  | "run"
  | "mission"
  | "step"
  | "tool"
  | "provider"
  | "approval"
  | "receipt"
  | "verification"
  | "compensation"
  | "reconciliation"
  | "memory"
  | "operator";

export interface ReliabilityTraceEvent {
  id: string;
  ownerId: number;
  kind: TraceEventKind;
  type: string;
  at: number;
  correlationId?: string;
  parentId?: string;
  status?: string;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ReplayEvent {
  at: number;
  type: string;
  id?: string;
  status?: string;
  data?: Record<string, unknown>;
}

export interface ReplayScenario {
  id: string;
  ownerId: number;
  missionId: string;
  events: ReplayEvent[];
  expected: {
    terminalStatus: "completed" | "blocked" | "failed" | "cancelled";
    requiredInvariants?: string[];
  };
}

export interface ReplayReport {
  scenarioId: string;
  status: "passed" | "failed";
  finalStatus: string;
  replayedEvents: number;
  violations: string[];
  checkpoints: string[];
}

export interface ReliabilitySample {
  id: string;
  ownerId: number;
  operation: string;
  at: number;
  status: "success" | "failure" | "uncertain" | "timeout";
  latencyMs?: number;
  costUsd?: number;
  provider?: string;
}

export interface ReliabilityHealth {
  operation: string;
  windowMs: number;
  sampleCount: number;
  successRate: number;
  uncertaintyRate: number;
  p95LatencyMs?: number;
  state: "healthy" | "degraded" | "meltdown";
  reasons: string[];
  calculatedAt: number;
}

export interface CompiledAutonomyPolicy {
  version: string;
  ownerId: number;
  mode: "personal" | "business";
  enabled: boolean;
  authority: "observe" | "prepare" | "execute_reversible";
  allowedDomains: string[];
  deniedDomains: string[];
  allowedTools: string[];
  deniedTools: string[];
  approvalTools: string[];
  maxChecksPerDay: number;
  maxActionsPerDay: number;
  maxToolCalls: number;
  maxCostUsd: number;
  compiledAt: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
  remaining: { toolCalls: number; costUsd: number; concurrent: number };
}
