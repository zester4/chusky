export type ProactiveRunState = "started" | "completed" | "blocked" | "failed" | "skipped";

export interface ProactiveHeartbeat {
  state: ProactiveRunState;
  occurrenceId: string;
  startedAt: number;
  completedAt?: number;
  watchesChecked: number;
  watchesChanged: number;
  observationsCreated: number;
  handled: number;
  delegated: number;
  approvals: number;
  failures: number;
  nextRunAt?: number;
}

export function proactiveHeartbeatText(heartbeat: ProactiveHeartbeat): string {
  const elapsed = heartbeat.completedAt && heartbeat.completedAt >= heartbeat.startedAt
    ? ` in ${Math.max(0, Math.round((heartbeat.completedAt - heartbeat.startedAt) / 1000))}s`
    : "";
  if (heartbeat.state === "failed") return `Elena pulse failed${elapsed}. Checked ${heartbeat.watchesChecked} watch${heartbeat.watchesChecked === 1 ? "" : "es"}; ${heartbeat.failures} failure${heartbeat.failures === 1 ? "" : "s"} recorded. I will not claim that provider state changed.`;
  if (heartbeat.state === "blocked") return `Elena pulse is waiting${elapsed}. Checked ${heartbeat.watchesChecked} watch${heartbeat.watchesChecked === 1 ? "" : "es"}; ${heartbeat.approvals} approval${heartbeat.approvals === 1 ? "" : "s"} or owner decision${heartbeat.approvals === 1 ? "" : "s"} remain.`;
  return `Elena pulse completed${elapsed}. Checked ${heartbeat.watchesChecked} watch${heartbeat.watchesChecked === 1 ? "" : "es"}; ${heartbeat.watchesChanged} changed, ${heartbeat.observationsCreated} new observation${heartbeat.observationsCreated === 1 ? "" : "s"}, ${heartbeat.handled} handled, ${heartbeat.delegated} delegated${heartbeat.nextRunAt ? `; next check ${new Date(heartbeat.nextRunAt).toISOString()}` : ""}.`;
}
