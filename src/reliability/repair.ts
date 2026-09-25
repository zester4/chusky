import type { MissionRecord } from "../store.js";
import type { CompensationRecord, ReliabilityHealth } from "./contracts.js";

export interface MissionRepairDiagnosis {
  missionId: string;
  severity: "low" | "medium" | "high" | "critical";
  causes: string[];
  safeNextActions: string[];
  requiresApproval: boolean;
  shouldPause: boolean;
}

/** Deterministic supervisor diagnosis; model text cannot choose a repair by itself. */
export function diagnoseMissionRepair(input: { mission: MissionRecord; compensations: CompensationRecord[]; health?: ReliabilityHealth }): MissionRepairDiagnosis {
  const causes: string[] = [];
  const safeNextActions: string[] = [];
  const pending = input.compensations.filter((item) => item.missionId === input.mission.id && ["pending", "failed", "blocked"].includes(item.status));
  if (input.mission.status === "failed" || input.mission.steps.some((step) => step.status === "failed")) {
    causes.push("mission_or_step_failed");
    safeNextActions.push("inspect_failed_step_and_provider_receipt");
  }
  if (pending.length) {
    causes.push("compensation_required");
    safeNextActions.push("review_and_approve_compensation_records");
  }
  if (input.health?.state === "meltdown") {
    causes.push("provider_or_operation_meltdown");
    safeNextActions.push("pause_operation_and_reconcile_provider_state");
  } else if (input.health?.state === "degraded") {
    causes.push("operation_degraded");
    safeNextActions.push("retry_with_backoff_or_select_healthier_route");
  }
  if (!causes.length) {
    causes.push("operator_requested_repair");
    safeNextActions.push("resume_from_last_verified_checkpoint");
  }
  const critical = causes.includes("provider_or_operation_meltdown") || pending.some((item) => item.status === "blocked");
  return { missionId: input.mission.id, severity: critical ? "critical" : pending.length ? "high" : input.health?.state === "degraded" ? "medium" : "low", causes, safeNextActions: [...new Set(safeNextActions)], requiresApproval: pending.length > 0, shouldPause: critical };
}
