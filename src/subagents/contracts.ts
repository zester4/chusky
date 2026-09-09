import type { CapabilityWorkerName } from "../memory/types.js";

export type ApprovalPolicy = "auto" | "require_chusky_approval";

/** Overall wall-clock budget for a durable worker goal. */
export type WorkerDuration = "5m" | "30m" | "1h" | "3h" | "6h" | "3d" | "1w";
export const WORKER_DURATION_SECONDS: Record<WorkerDuration, number> = {
  "5m": 5 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "3h": 3 * 60 * 60,
  "6h": 6 * 60 * 60,
  "3d": 3 * 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
};

export interface DelegationContract {
  id: string;
  supervisor: "chusky";
  worker: CapabilityWorkerName;
  objective: string;
  model?: string;
  /** Exact Composio action slugs selected by Chusky for this one delegation. */
  allowedComposioTools: string[];
  allowedTools: string[];
  context?: Record<string, unknown>;
  expectedOutput: string;
  approvalPolicy: ApprovalPolicy;
  timeoutSeconds: number;
  maxToolCalls: number;
  duration?: WorkerDuration;
  budgetSeconds?: number;
}

export type DelegationStatus =
  | "success"
  | "queued"
  | "cancel_requested"
  | "interrupted"
  | "failed"
  | "timed_out"
  | "max_tool_calls_exceeded"
  | "requires_approval"
  | "requires_tool_request"
  | "fallback_executed"
  | "cancelled";

export interface HandoffRecord {
  id: string;
  from: "chusky" | CapabilityWorkerName;
  to: "chusky" | CapabilityWorkerName;
  objective: string;
  context: Record<string, unknown>;
  expectedOutput: string;
  timestamp: number;
  status: DelegationStatus;
  taskId?: string;
  toolRequest?: { intent: string; reason: string; preferredToolkit?: string };
  workflowRunId?: string;
  toolRequestEventId?: string;
  resumeCount?: number;
  delegation?: {
    /** Durable execution record containing the exact worker model state. */
    runId?: string;
    model?: string;
    allowedTools: string[];
    allowedComposioTools: string[];
    approvalPolicy: ApprovalPolicy;
    timeoutSeconds: number;
    maxToolCalls: number;
    duration?: WorkerDuration;
    budgetSeconds?: number;
    startedAt?: number;
    continuationCount?: number;
  };
}

export interface DelegationResult {
  contractId: string;
  worker: CapabilityWorkerName;
  status: DelegationStatus;
  output: string;
  toolCallsCount: number;
  toolCallsLog: import("../cancellation.js").SafeToolAudit[];
  proposal?: {
    actionName: string;
    payload: Record<string, unknown>;
    requiresApproval: boolean;
  };
  approvalId?: string;
  toolRequest?: { intent: string; reason: string; preferredToolkit?: string };
  taskId?: string;
  handoffRecord?: HandoffRecord;
  durationMs: number;
}
