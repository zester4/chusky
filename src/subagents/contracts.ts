import type { CapabilityWorkerName } from "../memory/types.js";

export type ApprovalPolicy = "auto" | "require_chusky_approval";

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
}

export type DelegationStatus =
  | "success"
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
    model?: string;
    allowedTools: string[];
    allowedComposioTools: string[];
    approvalPolicy: ApprovalPolicy;
    timeoutSeconds: number;
    maxToolCalls: number;
  };
}

export interface DelegationResult {
  contractId: string;
  worker: CapabilityWorkerName;
  status: DelegationStatus;
  output: string;
  toolCallsCount: number;
  toolCallsLog: Array<{ tool: string; args: unknown; result?: unknown; error?: string }>;
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
