/** Durable work item used to reconcile a provider call without ever retrying
 * the provider side effect. The queue may retry reads and outcome persistence,
 * but it must never create a second call. */
export type VoiceCallReconciliationPhase = "provider" | "outcome";
export type VoiceCallReconciliationStatus = "pending" | "running";

export interface VoiceCallReconciliationRecord {
  id: string;
  userId: number;
  callId: string;
  provider: "twilio" | "bland";
  providerCallId?: string;
  phase: VoiceCallReconciliationPhase;
  status: VoiceCallReconciliationStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseToken?: string;
  leaseUntil?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}
