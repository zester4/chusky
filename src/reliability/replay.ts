import type { MissionRecord } from "../store.js";
import type { ReplayEvent, ReplayReport, ReplayScenario } from "./contracts.js";

type ReplayState = { status: string; completedSteps: Set<string>; checkpoints: string[]; approvals: Set<string>; receipts: Set<string> };

function apply(state: ReplayState, event: ReplayEvent, violations: string[]): void {
  switch (event.type) {
    case "mission.started":
      if (state.status !== "queued" && state.status !== "paused" && state.status !== "blocked") violations.push("mission_started_from_invalid_state");
      state.status = "running";
      break;
    case "mission.checkpoint":
      if (state.status !== "running" && state.status !== "waiting") violations.push("checkpoint_without_running_mission");
      if (event.data?.checkpoint) state.checkpoints.push(String(event.data.checkpoint));
      break;
    case "approval.waiting":
      state.status = "waiting";
      if (event.id) state.approvals.add(event.id);
      break;
    case "approval.resumed":
      if (event.id && !state.approvals.has(event.id)) violations.push("approval_resumed_without_waiting");
      state.status = "running";
      break;
    case "receipt.succeeded":
      if (event.id) state.receipts.add(event.id);
      break;
    case "step.completed":
      if (!event.id) violations.push("step_completed_without_id");
      else state.completedSteps.add(event.id);
      break;
    case "mission.completed":
      if (state.status !== "running" && state.status !== "waiting") violations.push("mission_completed_from_invalid_state");
      state.status = "completed";
      break;
    case "mission.blocked": state.status = "blocked"; break;
    case "mission.failed": state.status = "failed"; break;
    case "mission.cancelled": state.status = "cancelled"; break;
    default: break;
  }
}

export function replayScenario(scenario: ReplayScenario): ReplayReport {
  const events = [...scenario.events].sort((a, b) => a.at - b.at || a.type.localeCompare(b.type) || (a.id ?? "").localeCompare(b.id ?? ""));
  const violations: string[] = [];
  const state: ReplayState = { status: "queued", completedSteps: new Set(), checkpoints: [], approvals: new Set(), receipts: new Set() };
  const seen = new Set<string>();
  for (const event of events) {
    const identity = `${event.type}:${event.id ?? "-"}:${event.at}`;
    if (seen.has(identity)) { violations.push("duplicate_event_replayed"); continue; }
    seen.add(identity);
    apply(state, event, violations);
  }
  if (state.status !== scenario.expected.terminalStatus) violations.push(`terminal_status_expected_${scenario.expected.terminalStatus}_got_${state.status}`);
  for (const invariant of scenario.expected.requiredInvariants ?? []) {
    if (invariant === "every_completed_step_has_receipt" && [...state.completedSteps].some((step) => !state.receipts.has(step))) violations.push("completed_step_missing_receipt");
    if (invariant === "has_checkpoint" && state.checkpoints.length === 0) violations.push("missing_checkpoint");
  }
  return { scenarioId: scenario.id, status: violations.length ? "failed" : "passed", finalStatus: state.status, replayedEvents: events.length, violations, checkpoints: state.checkpoints };
}

/** Convert the durable mission event log into a deterministic replay scenario. */
export function replayMission(mission: MissionRecord): ReplayReport {
  const events: ReplayEvent[] = (mission.events ?? []).map((event) => {
    const type = event.type === "started" ? "mission.started"
      : event.type === "checkpointed" ? "mission.checkpoint"
      : event.type === "waiting" || event.type === "approval_waiting" ? "approval.waiting"
      : event.type === "approval_resumed" ? "approval.resumed"
      : event.type === "step_completed" ? "step.completed"
      : event.type === "completed" ? "mission.completed"
      : event.type === "blocked" ? "mission.blocked"
      : event.type === "failed" ? "mission.failed"
      : event.type === "cancelled" ? "mission.cancelled"
      : event.type === "provider_event" ? "receipt.succeeded" : "noop";
    return { at: event.at, type, id: event.stepId ?? event.providerEventId ?? event.id, data: { ...(event.metadata ?? {}), ...(event.type === "checkpointed" ? { checkpoint: event.message } : {}) } };
  });
  return replayScenario({ id: `replay_${mission.id}_${mission.version}`, ownerId: mission.userId, missionId: mission.id, events, expected: { terminalStatus: mission.status === "completed" || mission.status === "blocked" || mission.status === "failed" || mission.status === "cancelled" ? mission.status : "blocked", requiredInvariants: mission.status === "completed" ? ["has_checkpoint"] : [] } });
}
