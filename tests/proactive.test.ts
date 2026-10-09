import test from "node:test";
import assert from "node:assert/strict";
import { PROACTIVE_CAPABILITIES, proactiveCataloguePrompt } from "../src/proactive/catalog.js";
import { DEFAULT_PROACTIVE_WATCHES, PROACTIVE_WATCH_DEFINITIONS, connectedWatchInput, connectedWatchSpecs, defaultWatchInput, defaultWatchSpecsForConnectedAccounts, missingDefaultWatchKeys, normalizeProactiveCapabilityIds, proactiveWatchDefinition, watchCapabilityIds } from "../src/proactive/watches.js";
import { proactiveHeartbeatText } from "../src/proactive/heartbeat.js";
import { buildDailyOperatingBriefing, detectProactiveFindings, PROACTIVE_RUN_LEVEL_CAPABILITY_IDS, PROACTIVE_SIGNAL_CAPABILITY_IDS } from "../src/proactive/detectors.js";
import { attentionPulseDeliveryDecision } from "../src/attentionPulse.js";
import { configureAttentionPulse, syncDefaultProactiveWatchesForConnectedAccounts } from "../src/nativeTools.js";
import { addJob, createAttentionRecord, initStore, listAttentionRecords } from "../src/store.js";
import { runDueAutonomyWatches } from "../src/autonomy/reconciliation.js";
import { nativeTool } from "../src/nativeTools.js";
import { attentionChecklistPrompt } from "../src/proactive/checklist.js";

test("proactive catalogue contains all twenty bounded behaviors", () => {
  assert.equal(PROACTIVE_CAPABILITIES.length, 20);
  assert.equal(new Set(PROACTIVE_CAPABILITIES.map((item) => item.id)).size, 20);
  assert.match(proactiveCataloguePrompt(), /invoice_detection/);
  assert.match(proactiveCataloguePrompt(), /daily_operating_briefing/);
  assert.equal(PROACTIVE_WATCH_DEFINITIONS.length, 20);
  assert.equal(new Set(PROACTIVE_WATCH_DEFINITIONS.map((item) => item.capabilityId)).size, 20);
  assert.equal(proactiveWatchDefinition("invoice_detection")?.readOnly, true);
  assert.deepEqual(normalizeProactiveCapabilityIds(["invoice_detection", "invoice_detection"]), ["invoice_detection"]);
  assert.throws(() => normalizeProactiveCapabilityIds(["made_up_capability"]), /Unknown proactive capability/);
  assert.equal(new Set([...PROACTIVE_SIGNAL_CAPABILITY_IDS, ...PROACTIVE_RUN_LEVEL_CAPABILITY_IDS]).size, 20);
});

test("default watches are read-only and idempotently discoverable", () => {
  assert.equal(DEFAULT_PROACTIVE_WATCHES.length, 2);
  const input = defaultWatchInput(DEFAULT_PROACTIVE_WATCHES[0]!, 1_000);
  assert.equal(input.authority, "observe");
  assert.equal(input.nextCheckAt, 1_000);
  assert.equal((input.capabilityIds as string[]).length, 6);
  assert.deepEqual(watchCapabilityIds({ capabilityIds: ["invoice_detection", "invoice_detection"], domain: "gmail" }), ["invoice_detection"]);
  assert.deepEqual(missingDefaultWatchKeys([]).map((item) => item.key), ["gmail-recent", "calendar-upcoming"]);
  assert.deepEqual(missingDefaultWatchKeys([{ id: "w1", userId: 1, name: "Recent inbox", domain: "gmail", objective: "x", mode: "personal", cadenceSeconds: 3600, authority: "observe", status: "active", maxItems: 5, createdAt: 1, updatedAt: 1 }]).map((item) => item.key), [DEFAULT_PROACTIVE_WATCHES[1]!.key]);
});

test("unconnected starter providers do not become active watches", () => {
  assert.deepEqual(defaultWatchSpecsForConnectedAccounts([]), []);
  assert.deepEqual(defaultWatchSpecsForConnectedAccounts([
    { id: "gmail-1", toolkit: "GMAIL", status: "ACTIVE" },
    { id: "calendar-1", toolkit: "GOOGLE_CALENDAR", status: "CONNECTED" },
    { id: "disabled-calendar", toolkit: "GOOGLECALENDAR", status: "DISABLED" },
  ]).map((spec) => spec.key), ["gmail-recent", "calendar-upcoming"]);
});

test("connected app starter watches are bounded, account-scoped, and read-only", () => {
  const specs = connectedWatchSpecs([
    { id: "slack-1", toolkit: "slack", alias: "Work Slack", status: "ACTIVE" },
    { id: "github-1", toolkit: "github", status: "ACTIVE" },
    { id: "disabled", toolkit: "notion", status: "DISABLED" },
  ]);
  assert.deepEqual(specs.map((spec) => spec.key), ["slack-attention", "github-work"]);
  const input = connectedWatchInput(specs[0]!, 1_000);
  assert.equal(input.connectedAccountId, "slack-1");
  assert.equal(input.accountAlias, "Work Slack");
  assert.equal(input.authority, "observe");
  assert.equal(input.nextCheckAt, 1_000);
});

test("Elena's checklist is continuity context, not a closed task list", () => {
  assert.match(attentionChecklistPrompt(undefined), /create a concise initial working checklist/);
  assert.match(attentionChecklistPrompt({ content: "- Review Gmail next\n- Look for anything urgent", updatedAt: 1_000 }), /Review Gmail next/);
  assert.match(attentionChecklistPrompt({ content: "- Review Gmail next", updatedAt: 1_000 }), /last updated/);
});

test("heartbeat reports completed, blocked, and failed runs without overstating provider effects", () => {
  const base = { occurrenceId: "occ1", startedAt: 1_000, completedAt: 3_000, watchesChecked: 2, watchesChanged: 1, observationsCreated: 1, handled: 0, delegated: 1, approvals: 0, failures: 0 } as const;
  assert.match(proactiveHeartbeatText({ ...base, state: "completed" }), /completed in 2s/);
  assert.match(proactiveHeartbeatText({ ...base, state: "blocked", approvals: 1 }), /waiting/);
  assert.match(proactiveHeartbeatText({ ...base, state: "failed", failures: 1 }), /will not claim/);
});

test("proactive detectors cover communication, calendar, billing, work, and artifact signals", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const findings = detectProactiveFindings([
    { id: "mail1", source: "gmail", kind: "email", subject: "Urgent invoice review", status: "unread", updatedAt: now - 3 * 24 * 60 * 60_000, metadata: { priority: "urgent", attachment: true, evidence: "Please review and send tomorrow" } },
    { id: "meet1", source: "calendar", kind: "meeting", subject: "Client review", dueAt: now + 2 * 60 * 60_000, metadata: { preparationNeeded: true, conflict: true } },
    { id: "task1", source: "chusky", kind: "task", subject: "Import", status: "blocked" },
    { id: "bill1", source: "billing", kind: "invoice", subject: "Acme", status: "overdue" },
    { id: "file1", source: "drive", kind: "document", subject: "Plan", metadata: { changed: true } },
  ], now);
  const ids = new Set(findings.map((item) => item.capabilityId));
  for (const id of ["inbox_priority_scan", "unanswered_message", "email_commitment", "attachment_triage", "tomorrow_briefing", "meeting_preparation", "calendar_conflict", "stalled_task_recovery", "invoice_detection", "document_change_monitor"]) assert.equal(ids.has(id), true, id);
  assert.equal(findings.find((item) => item.capabilityId === "invoice_detection")?.actionClass, "approval");
});

test("pulse heartbeat is bounded by the existing delivery cap", () => {
  assert.equal(attentionPulseDeliveryDecision([{ id: "p", userId: 1, provider: "telegram", enabled: true, mode: "immediate", maxPerDay: 4, createdAt: 1, updatedAt: 1 }], Date.UTC(2026, 0, 1, 12), 3).suppressed, false);
  assert.equal(attentionPulseDeliveryDecision([{ id: "p", userId: 1, provider: "telegram", enabled: true, mode: "immediate", maxPerDay: 4, createdAt: 1, updatedAt: 1 }], Date.UTC(2026, 0, 1, 12), 4).reason, "daily_limit");
});

test("re-enabling an existing pulse repairs heartbeat without seeding disconnected watches", async () => {
  await initStore({ memoryOnly: true });
  const userId = 920001;
  await addJob(userId, { id: `pulse_${userId}`, userId, text: "Run pulse", cron: "0 * * * *", scheduleId: `schedule_${userId}`, status: "active", kind: "attention_pulse", createdAt: Date.now() });
  const result = await configureAttentionPulse(userId, { action: "enable" }) as { heartbeat?: boolean };
  const watches = await listAttentionRecords(userId, "autonomy_watch");
  assert.equal(result.heartbeat, true);
  assert.deepEqual(watches, []);
});

test("starter watches pause while disconnected and resume after the account returns", async () => {
  await initStore({ memoryOnly: true });
  const userId = 920004;
  const now = Date.UTC(2026, 9, 8, 12);
  await syncDefaultProactiveWatchesForConnectedAccounts(userId, [{ id: "gmail-1", toolkit: "gmail", status: "ACTIVE" }], now);
  let watches = await listAttentionRecords(userId, "autonomy_watch");
  assert.equal(watches[0]?.status, "active");
  await syncDefaultProactiveWatchesForConnectedAccounts(userId, [], now + 1);
  watches = await listAttentionRecords(userId, "autonomy_watch");
  assert.equal(watches[0]?.status, "paused");
  assert.match(watches[0]?.lastError ?? "", /matching connected app/);
  await syncDefaultProactiveWatchesForConnectedAccounts(userId, [{ id: "gmail-1", toolkit: "gmail", status: "ACTIVE" }], now + 2);
  watches = await listAttentionRecords(userId, "autonomy_watch");
  assert.equal(watches[0]?.status, "active");
  assert.equal(watches[0]?.nextCheckAt, now + 2);
});

test("daily operating briefing is bounded and reports verified run state", () => {
  const finding = { key: "k", capabilityId: "invoice_detection", title: "Invoice needs review", reason: "Overdue", nextAction: "Verify details", actionClass: "approval" as const, score: 0.9, evidence: { source: "billing" }, detectedAt: 1 };
  const brief = buildDailyOperatingBriefing({ findings: [finding], handled: 1, delegated: 2, approvals: 1, failures: 0, nextRunAt: 1_000 });
  assert.match(brief, /1 new finding/);
  assert.match(brief, /Invoice needs review/);
  assert.equal(brief.length < 2_000, true);
});

test("a typed watch produces a normalized observation and capability candidate", async () => {
  await initStore({ memoryOnly: true });
  const userId = 920002;
  const now = Date.UTC(2026, 9, 7, 12);
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Calendar conflict watch", domain: "calendar", toolkit: "googlecalendar", capabilityIds: ["calendar_conflict", "tomorrow_briefing"],
    objective: "Find changed calendar events", toolSlugs: ["GOOGLECALENDAR_LIST_EVENTS"], cadenceSeconds: 3600, authority: "observe", status: "active", maxItems: 10, nextCheckAt: now,
  });
  const result = await runDueAutonomyWatches(userId, {
    mode: "personal", now,
    execute: async () => ({ text: `AUTONOMY_RESULT: ${JSON.stringify({ changed: true, summary: "Calendar conflict found", signals: [{ id: "event-1", source: "calendar", kind: "meeting", subject: "Client review", dueAt: now + 3_600_000, metadata: { conflict: true } }] })}` }),
  });
  assert.equal(result[0]?.status, "completed");
  const observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations[0]?.metadata?.capabilityIds, "calendar_conflict,tomorrow_briefing");
  const candidates = await listAttentionRecords(userId, "attention_candidate") as any[];
  assert.equal(candidates.some((item) => item.reason.includes("calendar_conflict")), true);
});

test("native attention state rejects invented or writable typed watch capabilities", async () => {
  await initStore({ memoryOnly: true });
  const base = { action: "create", kind: "autonomy_watch", name: "Inbox", domain: "gmail", objective: "Read inbox", cadenceSeconds: 3600, maxItems: 5 };
  await assert.rejects(() => nativeTool(920003, "CHUCK_ATTENTION_STATE", { ...base, capabilityIds: ["not_registered"] }), /Unknown proactive capability/);
  await assert.rejects(() => nativeTool(920003, "CHUCK_ATTENTION_STATE", { ...base, capabilityIds: ["inbox_priority_scan"], authority: "prepare" }), /read-only/);
  const created = await nativeTool(920003, "CHUCK_ATTENTION_STATE", { ...base, capabilityIds: ["inbox_priority_scan"], authority: "observe" }) as { capabilityIds?: string[]; authority?: string };
  assert.deepEqual(created.capabilityIds, ["inbox_priority_scan"]);
  assert.equal(created.authority, "observe");
});
