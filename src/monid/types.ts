export interface MonidSpendSnapshot {
  userId: number;
  dayKey: string;
  spentUsd: number;
  reservedUsd: number;
  missionSpent: Record<string, number>;
  missionReserved: Record<string, number>;
  rateWindowKey?: string;
  rateWindowCalls: number;
  reservations: Record<string, { estimateUsd: number; missionId?: string }>;
}

export interface MonidSpendReservation {
  id: string;
  userId: number;
  dayKey: string;
  estimateUsd: number;
  missionId?: string;
  rateWindowKey: string;
}

export type MonidRunState = "submitting" | "uncertain" | "running" | "completed" | "failed" | "blocked" | "stopped" | "timed_out";

/** Safe receipt metadata only. Never store endpoint input or raw provider output here. */
export interface MonidRunReceipt {
  id: string;
  userId: number;
  organizationId?: string;
  missionId?: string;
  runId?: string;
  reservation?: MonidSpendReservation;
  provider: string;
  endpoint: string;
  state: MonidRunState;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  providerHttpStatus?: number;
  resultCount?: number;
  createdAt: number;
  updatedAt: number;
  durationMs?: number;
  error?: string;
}
