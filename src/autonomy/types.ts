/**
 * Shared contracts for autonomous work.
 *
 * These records deliberately contain references and bounded summaries rather
 * than provider payloads or credentials. They are safe to persist in the
 * owner-scoped session store and are the common language between reminders,
 * recurring jobs, missions, and future event-driven wakeups.
 */

export type AutonomyMode = "notify" | "check_in" | "act" | "wait_until";

export interface AutonomyLinks {
  taskId?: string;
  missionId?: string;
  missionStepId?: string;
  openLoopId?: string;
  attentionCandidateId?: string;
  projectId?: string;
  meetingId?: string;
  conversationId?: string;
}
export interface AutonomyContextSnapshot {
  capturedAt: number;
  objective: string;
  summary?: string;
  nextAction?: string;
  links?: AutonomyLinks;
  freshnessMs?: number;
  source?: "live" | "checkpoint" | "user" | "system";
}

export type AutonomyExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface AutonomousRunRecord {
  id: string;
  userId: number;
  kind: "reminder" | "job" | "mission" | "task" | "pulse";
  sourceId: string;
  occurrenceId?: string;
  status: AutonomyExecutionStatus;
  mode: AutonomyMode;
  idempotencyKey: string;
  objective: string;
  context?: AutonomyContextSnapshot;
  nextAction?: string;
  waitReason?: string;
  error?: string;
  cost?: number;
  toolCalls?: number;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface JobOccurrenceRecord {
  id: string;
  userId: number;
  jobId: string;
  occurrenceId: string;
  status: AutonomyExecutionStatus;
  mode: AutonomyMode;
  idempotencyKey: string;
  context?: AutonomyContextSnapshot;
  result?: string;
  nextAction?: string;
  waitReason?: string;
  error?: string;
  cost?: number;
  toolCalls?: number;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}
