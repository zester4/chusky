/**
 * Product-level health for the owner-scoped Attention Pulse.
 *
 * This is intentionally a pure classifier. It does not inspect providers,
 * mutate schedules, or decide whether Elena may act. Those boundaries belong
 * to the pulse runner and the existing approval policy. Keeping the classifier
 * pure makes the status contract deterministic for the API, dashboard, and
 * tests while still allowing the agent to remain flexible.
 */

export type PulseCadence = "every_30_minutes" | "hourly" | "daily";
export type PulseHealthStatus =
  | "off"
  | "waiting_for_connection"
  | "waiting_for_setup"
  | "never_run"
  | "running"
  | "healthy"
  | "watch_attention"
  | "stale"
  | "failed";
export type PulseRecoveryAction = "none" | "connect_app" | "run_now" | "inspect";

export interface PulseHealthOccurrence {
  status: string;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  error?: string;
}

export interface PulseHealthInput {
  enabled: boolean;
  cadence: PulseCadence;
  now?: number;
  jobStatus?: "active" | "paused" | "cancelled";
  latestOccurrence?: PulseHealthOccurrence;
  activeWatches: number;
  currentWatches: number;
  scheduledWatches: number;
  staleWatches: number;
  failedWatches: number;
  neverCheckedWatches: number;
  pendingSuggestions: number;
  connectedAccountsVerified: boolean;
}

export interface PulseHealth {
  status: PulseHealthStatus;
  title: string;
  summary: string;
  recoveryAction: PulseRecoveryAction;
  expectedIntervalMs: number;
  activeWatches: number;
  currentWatches: number;
  scheduledWatches: number;
  staleWatches: number;
  failedWatches: number;
  neverCheckedWatches: number;
  pendingSuggestions: number;
  connectedAccountsVerified: boolean;
  lastRunAt?: number;
  lastRunStatus?: string;
  lastError?: string;
}

const CADENCE_INTERVAL_MS: Record<PulseCadence, number> = {
  every_30_minutes: 30 * 60_000,
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function latestActivityAt(occurrence?: PulseHealthOccurrence): number | undefined {
  if (!occurrence) return undefined;
  const values = [occurrence.completedAt, occurrence.startedAt, occurrence.updatedAt]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : undefined;
}

/**
 * Classify Pulse state without treating a missing provider connection as a
 * scheduler failure. A missing connection is an actionable product state:
 * Elena should explain what a connection unlocks and offer that next step.
 */
export function classifyPulseHealth(input: PulseHealthInput): PulseHealth {
  const now = input.now ?? Date.now();
  const expectedIntervalMs = CADENCE_INTERVAL_MS[input.cadence];
  const activeWatches = boundedCount(input.activeWatches);
  const currentWatches = boundedCount(input.currentWatches);
  const scheduledWatches = boundedCount(input.scheduledWatches);
  const staleWatches = boundedCount(input.staleWatches);
  const failedWatches = boundedCount(input.failedWatches);
  const neverCheckedWatches = boundedCount(input.neverCheckedWatches);
  const pendingSuggestions = boundedCount(input.pendingSuggestions);
  const lastRunAt = latestActivityAt(input.latestOccurrence);
  const lastRunStatus = input.latestOccurrence?.status;
  const lastError = input.latestOccurrence?.error?.slice(0, 500);
  const base = {
    expectedIntervalMs,
    activeWatches,
    currentWatches,
    scheduledWatches,
    staleWatches,
    failedWatches,
    neverCheckedWatches,
    pendingSuggestions,
    connectedAccountsVerified: input.connectedAccountsVerified,
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(lastRunStatus ? { lastRunStatus } : {}),
    ...(lastError ? { lastError } : {}),
  };

  if (!input.enabled || input.jobStatus === "paused" || input.jobStatus === "cancelled") {
    return { ...base, status: "off", title: "Pulse is paused", summary: "Elena is not scheduled to review your attention state.", recoveryAction: "none" };
  }

  if (input.latestOccurrence && ["queued", "running", "waiting"].includes(input.latestOccurrence.status)) {
    return { ...base, status: "running", title: "Elena is working", summary: "The latest Pulse run is still in progress. Its result will be recorded before Elena reports completion.", recoveryAction: "none" };
  }

  if (input.latestOccurrence && ["failed", "blocked", "cancelled"].includes(input.latestOccurrence.status)) {
    return { ...base, status: "failed", title: "Pulse needs recovery", summary: lastError ? `The latest Pulse run did not finish: ${lastError}` : "The latest Pulse run did not finish. Inspect the run before retrying so work is not duplicated.", recoveryAction: "inspect" };
  }

  if (activeWatches === 0 && pendingSuggestions > 0) {
    return { ...base, status: "waiting_for_connection", title: "Pulse is ready for a connected app", summary: "Elena can still suggest useful work, but no connected app is available for a bounded watch yet.", recoveryAction: "connect_app" };
  }

  if (activeWatches === 0) {
    return { ...base, status: "waiting_for_setup", title: "Pulse is waiting for its first watch", summary: input.connectedAccountsVerified ? "No active watch is configured yet. Elena can review durable work and suggest the next useful capability." : "Pulse could not verify connected-app inventory yet, so it is not claiming provider coverage.", recoveryAction: "inspect" };
  }

  if (!lastRunAt) {
    return { ...base, status: "never_run", title: "Pulse has not run yet", summary: "Your watches are configured, but Elena has no completed Pulse run to report yet.", recoveryAction: "run_now" };
  }

  if (now - lastRunAt > expectedIntervalMs * 2) {
    return { ...base, status: "stale", title: "Pulse is overdue", summary: `The last Pulse activity is older than two ${input.cadence === "daily" ? "daily intervals" : "scheduled intervals"}. Run it now or inspect the durable job before changing its schedule.`, recoveryAction: "inspect" };
  }

  if (failedWatches > 0 || staleWatches > 0 || neverCheckedWatches > 0) {
    return { ...base, status: "watch_attention", title: "Pulse is running with watch gaps", summary: `${failedWatches + staleWatches + neverCheckedWatches} configured watch${failedWatches + staleWatches + neverCheckedWatches === 1 ? "" : "es"} still needs a fresh verified check.`, recoveryAction: "inspect" };
  }

  return { ...base, status: "healthy", title: "Pulse is watching", summary: "Elena has a recent completed run and current watch coverage. New work will appear in Attention Center when it needs you.", recoveryAction: "none" };
}
