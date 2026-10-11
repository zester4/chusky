import assert from "node:assert/strict";
import test from "node:test";
import { classifyPulseHealth } from "../src/proactive/pulseHealth.js";

const base = {
  enabled: true,
  cadence: "hourly" as const,
  now: Date.UTC(2026, 9, 9, 12),
  activeWatches: 1,
  currentWatches: 1,
  scheduledWatches: 0,
  staleWatches: 0,
  failedWatches: 0,
  neverCheckedWatches: 0,
  pendingSuggestions: 0,
  connectedAccountsVerified: true,
};

test("Pulse health treats a missing connection as an actionable waiting state", () => {
  const health = classifyPulseHealth({ ...base, activeWatches: 0, currentWatches: 0, pendingSuggestions: 2 });
  assert.equal(health.status, "waiting_for_connection");
  assert.equal(health.recoveryAction, "connect_app");
  assert.match(health.summary, /connected app/);
});

test("Pulse health does not call connected apps disconnected when watch setup is missing", () => {
  const health = classifyPulseHealth({
    ...base,
    activeWatches: 0,
    currentWatches: 0,
    connectedAccountCount: 4,
    connectedToolkits: ["gmail", "googlecalendar", "googlesheets", "notion"],
  });
  assert.equal(health.status, "waiting_for_setup");
  assert.equal(health.recoveryAction, "inspect");
  assert.match(health.title, /not monitored/);
  assert.match(health.summary, /Pulse sees gmail, googlecalendar, googlesheets, notion/);
});

test("Pulse health exposes a connected-app reconciliation failure", () => {
  const health = classifyPulseHealth({
    ...base,
    connectionError: "Pulse could not verify the connected-app inventory",
  });
  assert.equal(health.status, "failed");
  assert.equal(health.recoveryAction, "inspect");
  assert.equal(health.connectionError, "Pulse could not verify the connected-app inventory");
});

test("Pulse health distinguishes first-run setup from a stale scheduler", () => {
  const firstRun = classifyPulseHealth({ ...base, latestOccurrence: undefined });
  assert.equal(firstRun.status, "never_run");
  assert.equal(firstRun.recoveryAction, "run_now");

  const staleAt = base.now - 3 * 60 * 60_000;
  const stale = classifyPulseHealth({ ...base, latestOccurrence: { status: "completed", completedAt: staleAt, updatedAt: staleAt } });
  assert.equal(stale.status, "stale");
  assert.equal(stale.recoveryAction, "inspect");
});

test("Pulse health does not mark a daily pulse stale after one day", () => {
  const health = classifyPulseHealth({
    ...base,
    cadence: "daily",
    latestOccurrence: { status: "completed", completedAt: base.now - 25 * 60 * 60_000, updatedAt: base.now - 25 * 60 * 60_000 },
  });
  assert.equal(health.status, "healthy");
});

test("Pulse health exposes in-flight and failed runs without hiding watch gaps", () => {
  const running = classifyPulseHealth({ ...base, latestOccurrence: { status: "running", startedAt: base.now - 1_000 } });
  assert.equal(running.status, "running");
  assert.equal(running.recoveryAction, "none");

  const failed = classifyPulseHealth({ ...base, latestOccurrence: { status: "failed", updatedAt: base.now - 1_000, error: "QStash delivery failed" } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.recoveryAction, "inspect");

  const watchGap = classifyPulseHealth({ ...base, latestOccurrence: { status: "completed", completedAt: base.now - 1_000, updatedAt: base.now - 1_000 }, staleWatches: 1, currentWatches: 0 });
  assert.equal(watchGap.status, "watch_attention");
});

test("schedule recovery errors are reported as a failed Pulse", () => {
  const health = classifyPulseHealth({
    ...base,
    scheduleError: "QStash schedule recovery failed: provider unavailable",
  });
  assert.equal(health.status, "failed");
  assert.equal(health.recoveryAction, "inspect");
  assert.match(health.summary, /provider unavailable/);
  assert.match(health.lastError ?? "", /QStash schedule recovery failed/);
});
