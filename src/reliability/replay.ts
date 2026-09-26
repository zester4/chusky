import type { MissionRecord } from "../store.js";
import type { ReplayEvent, ReplayReport, ReplayScenario } from "./contracts.js";

type ReplayState = {
  status: string;
  completedSteps: Set<string>;
  startedSteps: Set<string>;
  checkpoints: string[];
  approvals: Set<string>;
  receipts: Set<string>;
  stepReceipts: Set<string>;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function apply(state: ReplayState, event: ReplayEvent, violations: string[]): void {
  if (TERMINAL.has(state.status) && event.type !== "noop") {
    violations.push("event_after_terminal_state");
    return;
  }
  switch (event.type) {
    case "mission.started":
      if (state.status !== "queued" && state.status !== "paused" && state.status !== "blocked" && state.status !== "failed") violations.push("mission_started_from_invalid_state");
      else state.status = "running";
      break;
    case "mission.paused":
      if (state.status !== "running" && state.status !== "waiting") violations.push("mission_paused_from_invalid_state");
      else state.status = "paused";
      break;
    case "mission.waiting":
      if (state.status !== "running" && state.status !== "waiting") violations.push("mission_waited_from_invalid_state");
      else state.status = "waiting";
      break;
    case "mission.resumed":
      if (state.status !== "paused" && state.status !== "blocked" && state.status !== "failed" && state.status !== "waiting") violations.push("mission_resumed_from_invalid_state");
      else state.status = "running";
      break;
    case "mission.checkpoint":
      if (state.status !== "running" && state.status !== "waiting") violations.push("checkpoint_without_running_mission");
      if (event.data?.checkpoint) state.checkpoints.push(String(event.data.checkpoint).slice(0, 500));
      break;
    case "approval.waiting":
      if (state.status !== "running" && state.status !== "waiting") violations.push("approval_waited_from_invalid_state");
      if (!event.id) violations.push("approval_waiting_without_id");
      else if (state.approvals.has(event.id)) violations.push("duplicate_approval_wait");
      else state.approvals.add(event.id);
      state.status = "waiting";
      break;
    case "approval.resumed":
      if (!event.id || !state.approvals.has(event.id)) violations.push("approval_resumed_without_matching_wait");
      else state.approvals.delete(event.id);
      if (state.approvals.size === 0) state.status = "running";
      else state.status = "waiting";
      break;
    case "receipt.succeeded":
      if (event.id) state.receipts.add(event.id);
      if (typeof event.data?.stepId === "string") state.stepReceipts.add(event.data.stepId);
      break;
    case "step.started": {
      const stepId = event.id;
      if (state.status !== "running") violations.push("step_started_without_running_mission");
      if (!stepId) { violations.push("step_started_without_id"); break; }
      if (state.startedSteps.has(stepId) || state.completedSteps.has(stepId)) violations.push("step_started_more_than_once");
      const dependsOn = Array.isArray(event.data?.dependsOn) ? event.data.dependsOn.filter((item): item is string => typeof item === "string") : [];
      if (dependsOn.some((dependency) => !state.completedSteps.has(dependency))) violations.push("step_started_before_dependencies_completed");
      state.startedSteps.add(stepId);
      break;
    }
    case "step.completed": {
      const stepId = event.id;
      if (state.status !== "running") violations.push("step_completed_without_running_mission");
      if (!stepId) { violations.push("step_completed_without_id"); break; }
      if (!state.startedSteps.has(stepId)) violations.push("step_completed_without_start");
      if (state.completedSteps.has(stepId)) violations.push("step_completed_more_than_once");
      const dependsOn = Array.isArray(event.data?.dependsOn) ? event.data.dependsOn.filter((item): item is string => typeof item === "string") : [];
      if (dependsOn.some((dependency) => !state.completedSteps.has(dependency))) violations.push("step_completed_before_dependencies_completed");
      state.completedSteps.add(stepId);
      break;
    }
    case "mission.completed":
      if (state.status !== "running") violations.push("mission_completed_from_invalid_state");
      if (state.approvals.size) violations.push("mission_completed_with_pending_approval");
      state.status = "completed";
      break;
    case "mission.blocked":
      if (TERMINAL.has(state.status)) violations.push("mission_blocked_from_terminal_state");
      state.status = "blocked";
      break;
    case "mission.failed":
      if (state.status !== "running" && state.status !== "waiting" && state.status !== "paused") violations.push("mission_failed_from_invalid_state");
      state.status = "failed";
      break;
    case "mission.cancelled":
      state.status = "cancelled";
      break;
    default: break;
  }
}

export function replayScenario(scenario: ReplayScenario): ReplayReport {
  const violations: string[] = [];
  const sourceEvents = Array.isArray(scenario?.events) ? scenario.events : [];
  if (sourceEvents.length > 5000) violations.push("event_limit_exceeded");
  const events = sourceEvents.slice(0, 5000).flatMap((raw): ReplayEvent[] => {
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string" || !Number.isFinite(raw.at)) {
      violations.push("malformed_replay_event");
      return [];
    }
    if (raw.at < 0) violations.push("invalid_event_timestamp");
    const data: Record<string, unknown> = {};
    if (typeof raw.data?.checkpoint === "string") data.checkpoint = raw.data.checkpoint.slice(0, 500);
    if (typeof raw.data?.stepId === "string") data.stepId = raw.data.stepId.slice(0, 160);
    if (Array.isArray(raw.data?.dependsOn)) data.dependsOn = raw.data.dependsOn.slice(0, 100).filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 160));
    return [{ at: raw.at, type: raw.type.slice(0, 120), ...(typeof raw.eventId === "string" ? { eventId: raw.eventId.slice(0, 200) } : {}), ...(typeof raw.id === "string" ? { id: raw.id.slice(0, 200) } : {}), data }];
  }).map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(({ event }) => event);
  const state: ReplayState = { status: "queued", completedSteps: new Set(), startedSteps: new Set(), checkpoints: [], approvals: new Set(), receipts: new Set(), stepReceipts: new Set() };
  const seen = new Set<string>();
  for (const event of events) {
    const identity = event.eventId ? `event-id:${event.eventId}` : event.id ? `entity:${event.type}:${event.id}` : `event:${event.type}:${event.at}`;
    if (seen.has(identity)) { violations.push("duplicate_event_replayed"); continue; }
    seen.add(identity);
    apply(state, event, violations);
  }
  const terminalStatus = scenario?.expected?.terminalStatus;
  if (!["completed", "blocked", "failed", "cancelled"].includes(terminalStatus)) violations.push("invalid_expected_terminal_status");
  if (state.status !== terminalStatus) violations.push(`terminal_status_expected_${String(terminalStatus)}_got_${state.status}`);
  const supportedInvariants = new Set(["every_completed_step_has_receipt", "has_checkpoint", "no_pending_approvals"]);
  for (const invariant of Array.isArray(scenario?.expected?.requiredInvariants) ? scenario.expected.requiredInvariants.slice(0, 50) : []) {
    if (!supportedInvariants.has(invariant)) { violations.push(`unsupported_invariant:${String(invariant).slice(0, 120)}`); continue; }
    if (invariant === "every_completed_step_has_receipt" && [...state.completedSteps].some((step) => !state.stepReceipts.has(step))) violations.push("completed_step_missing_receipt");
    if (invariant === "has_checkpoint" && state.checkpoints.length === 0) violations.push("missing_checkpoint");
    if (invariant === "no_pending_approvals" && state.approvals.size > 0) violations.push("pending_approval_at_terminal_state");
  }
  return { scenarioId: scenario.id, status: violations.length ? "failed" : "passed", finalStatus: state.status, replayedEvents: events.length, violations: [...new Set(violations)], checkpoints: state.checkpoints };
}

/** Replay durable lifecycle events and independently check the final mission record. */
export function replayMission(mission: MissionRecord): ReplayReport {
  const events: ReplayEvent[] = (mission.events ?? []).map((event) => {
    const type = event.type === "started" ? "mission.started"
      : event.type === "checkpointed" ? "mission.checkpoint"
      : event.type === "waiting" ? "mission.waiting"
      : event.type === "approval_waiting" ? "approval.waiting"
      : event.type === "approval_resumed" ? "approval.resumed"
      : event.type === "resumed" ? "mission.resumed"
      : event.type === "paused" ? "mission.paused"
      : event.type === "step_started" && event.stepId ? "step.started"
      : event.type === "step_completed" ? "step.completed"
      : event.type === "step_failed" ? "mission.failed"
      : event.type === "completed" ? "mission.completed"
      : event.type === "blocked" || event.type === "repaired" || event.type === "budget_exhausted" ? "mission.blocked"
      : event.type === "failed" ? "mission.failed"
      : event.type === "cancelled" ? "mission.cancelled"
      : event.type === "provider_event" ? "mission.resumed" : "noop";
    const stepId = event.stepId ?? (/^step ([^ ]+) completed\b/i.exec(event.message)?.[1]);
    const approvalId = typeof event.metadata?.approvalId === "string" ? event.metadata.approvalId : undefined;
    const id = type === "step.completed" || type === "step.started"
      ? stepId
      : type === "approval.waiting" || type === "approval.resumed"
        ? approvalId
        : event.id;
    return { at: event.at, type, eventId: event.id, ...(id ? { id } : {}), data: { ...(event.metadata ?? {}), ...(event.type === "checkpointed" ? { checkpoint: event.message } : {}), ...(event.type === "provider_event" ? { stepId: event.stepId } : {}) } };
  });
  const terminal = mission.status === "completed" || mission.status === "blocked" || mission.status === "failed" || mission.status === "cancelled";
  const terminalStatus = terminal ? mission.status as "completed" | "blocked" | "failed" | "cancelled" : "blocked";
  const report = replayScenario({ id: `replay_${mission.id}_${mission.version}`, ownerId: mission.userId, missionId: mission.id, events, expected: { terminalStatus, requiredInvariants: mission.status === "completed" ? ["has_checkpoint", "no_pending_approvals"] : [] } });
  const violations = [...report.violations];
  if (!terminal) violations.push("mission_is_not_in_a_terminal_state");
  if (mission.status === "completed") {
    if (mission.events.some((event) => event.type === "waiting" && /^Approve or deny .+ \([^)]+\) before the mission can continue\.$/i.test(event.message))) {
      violations.push("legacy_approval_wait_missing_structured_lifecycle");
    }
    if (!mission.result?.trim()) violations.push("completed_mission_missing_result");
    if (mission.steps.some((step) => step.status !== "completed")) violations.push("completed_mission_has_incomplete_steps");
    if (mission.steps.some((step) => step.dependsOn.some((dependency) => !mission.steps.some((candidate) => candidate.id === dependency && candidate.status === "completed")))) violations.push("completed_mission_has_unmet_dependencies");
    if (mission.verification?.mode === "strict" && (!mission.verification.verified || (mission.verification.unresolved?.length ?? 0) > 0)) violations.push("completed_mission_lacks_verified_definition_of_done");
  }
  const uniqueViolations = [...new Set(violations)];
  return { ...report, status: uniqueViolations.length ? "failed" : "passed", violations: uniqueViolations };
}
