import test from "node:test";
import assert from "node:assert/strict";
import { attentionPulseCloseoutOutput, attentionPulseDeliveredToday, attentionPulseDeliveryConfirmation, attentionPulseDeliveryDecision, attentionPulseHasHandlingEvidence, attentionPulseRefreshOwnerState, attentionPulseRequireDueWatchReport, buildAttentionPulsePlan, isWithinQuietHours, isNoActionPulseOutput, markAttentionPulseDelivered, recordAttentionPulseDelivery, selectAttentionPulseDeliveryTarget } from "../src/attentionPulse.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { configureAttentionPulse } from "../src/nativeTools.js";
import { addJob, addRecallMeeting, addReminder, blockTask, createApproval, createAttentionRecord, createJobOccurrence, createMission, createTask, createTriggerEvent, initStore, listAttentionRecords, listHandoffRecords, pauseMission, repairMission, saveCalendarMeetingPreparation, updateAttentionRecord, updateTask, type DeliveryPreferenceRecord } from "../src/store.js";
import { executeDelegation } from "../src/subagents/executor.js";

const preference = (patch: Partial<DeliveryPreferenceRecord> = {}): DeliveryPreferenceRecord => ({
  id: "pref_test", userId: 1, provider: "telegram", enabled: true, mode: "immediate", createdAt: 1, updatedAt: 1, ...patch,
});

test("attention pulse applies wrapped and non-wrapped quiet hours", () => {
  assert.equal(isWithinQuietHours(23 * 60 + 30, { startMinute: 23 * 60, endMinute: 60 }), true);
  assert.equal(isWithinQuietHours(30, { startMinute: 23 * 60, endMinute: 60 }), true);
  assert.equal(isWithinQuietHours(12 * 60, { startMinute: 23 * 60, endMinute: 60 }), false);
  assert.equal(isWithinQuietHours(9 * 60, { startMinute: 8 * 60, endMinute: 10 * 60 }), true);
});

test("attention pulse defaults to Telegram delivery and honors explicit controls", () => {
  assert.equal(attentionPulseDeliveryDecision([], Date.UTC(2026, 0, 1, 12, 0)).suppressed, false);
  assert.equal(attentionPulseDeliveryDecision([preference({ mode: "silent" })]).reason, "silent");
  assert.equal(attentionPulseDeliveryDecision([preference({ quietHoursUtc: { startMinute: 12 * 60, endMinute: 12 * 60 } })], Date.UTC(2026, 0, 1, 12, 0)).reason, undefined);
  assert.equal(attentionPulseDeliveryDecision([preference({ quietHoursUtc: { startMinute: 0, endMinute: 1439 } })], Date.UTC(2026, 0, 1, 12, 0)).reason, "quiet_hours");
  assert.equal(attentionPulseDeliveryDecision([preference({ maxPerDay: 2 })], Date.UTC(2026, 0, 1, 12, 0), 2).reason, "daily_limit");
});

test("attention pulse prefers only an active, opted-in private iMessage link when no channel was selected", () => {
  const linked = { accountId: "account_1", userId: 1, provider: "sendblue" as const, externalUserId: "+15550001", verifiedAt: 1, createdAt: 1, updatedAt: 1 };
  const telegram = { provider: "telegram" as const, conversationId: "99" };
  assert.deepEqual(selectAttentionPulseDeliveryTarget([linked], [], telegram, true), { provider: "sendblue", conversationId: "+15550001" });
  assert.deepEqual(selectAttentionPulseDeliveryTarget([{ ...linked, proactiveOptIn: false }], [], telegram, true), telegram);
  assert.deepEqual(selectAttentionPulseDeliveryTarget([{ ...linked, disabledAt: 2 }], [], telegram, true), telegram);
  assert.deepEqual(selectAttentionPulseDeliveryTarget([linked], [preference({ provider: "sendblue", conversationId: linked.externalUserId, enabled: false })], telegram, true), telegram);
  assert.deepEqual(selectAttentionPulseDeliveryTarget([linked], [], telegram, false), telegram);
});

test("attention pulse routes an explicitly selected Slack identity and does not silently override Telegram", () => {
  const slack = { accountId: "account_1", userId: 1, provider: "slack" as const, externalUserId: "U123", workspaceId: "T123", verifiedAt: 1, createdAt: 1, updatedAt: 1 };
  const telegram = { provider: "telegram" as const, conversationId: "99" };
  assert.deepEqual(selectAttentionPulseDeliveryTarget([slack], [preference({ provider: "slack", conversationId: "U123" })], telegram, { slack: true, sendblue: false }), { provider: "slack", conversationId: "U123" });
  assert.deepEqual(selectAttentionPulseDeliveryTarget([slack], [preference({ provider: "telegram" })], telegram, { slack: true, sendblue: false }), telegram);
});

test("attention pulse delivery controls are scoped to the selected channel", () => {
  const telegramSilent = preference({ mode: "silent" });
  const sendblueQuiet = preference({ provider: "sendblue", conversationId: "+15550001", quietHoursUtc: { startMinute: 0, endMinute: 1439 } });
  const now = Date.UTC(2026, 0, 1, 12, 0);
  assert.equal(attentionPulseDeliveryDecision([telegramSilent], now, 0, { provider: "sendblue", conversationId: "+15550001" }).suppressed, false);
  assert.equal(attentionPulseDeliveryDecision([sendblueQuiet], now, 0, { provider: "sendblue", conversationId: "+15550001" }).reason, "quiet_hours");
});

test("attention pulse counts delivered digests on the job and resets at UTC midnight", () => {
  const first = recordAttentionPulseDelivery(undefined, Date.UTC(2026, 0, 1, 10, 0));
  assert.equal(attentionPulseDeliveredToday(first, Date.UTC(2026, 0, 1, 11, 0)), 1);
  const second = recordAttentionPulseDelivery(first, Date.UTC(2026, 0, 1, 12, 0));
  assert.equal(attentionPulseDeliveredToday(second, Date.UTC(2026, 0, 1, 13, 0)), 2);
  assert.equal(attentionPulseDeliveredToday(second, Date.UTC(2026, 0, 2, 0, 0)), 0);
  assert.equal(attentionPulseDeliveredToday({ lastDeliveredAt: Date.UTC(2026, 0, 1, 10, 0) }, Date.UTC(2026, 0, 2, 0, 0)), 0);
});

test("attention pulse native contract and no-action sentinel are stable", () => {
  validateNativeToolArguments("CHUCK_ATTENTION_PULSE", { action: "enable" });
  assert.equal(isNoActionPulseOutput(" no_action\n"), true);
  assert.equal(isNoActionPulseOutput("There is an action"), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_READ_SKILL_FILE", status: "completed" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_CONTEXT_SEARCH", status: "completed" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "COMPOSIO_SEARCH_WEB", status: "completed" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "COMPOSIO_HUBSPOT_GET_CONTACT", status: "completed" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "COMPOSIO_HUBSPOT_CREATE_CONTACT", status: "completed" }]), true);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_HANDOFF_SUBAGENT", status: "completed" }]), true);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_TASK_COMPLETE", status: "completed" }]), true);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_AUTONOMY_RECONCILE", status: "completed" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_TASK_COMPLETE", status: "started" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_TASK_COMPLETE" }]), false);
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_TASK_COMPLETE", status: "failed" }]), false);
});

test("attention pulse checkpoints delivered owner digests without falsely completing candidates", () => {
  const plan = { candidateIds: ["candidate_1"], dedupeKey: "digest_1" };
  assert.deepEqual(attentionPulseDeliveryConfirmation(plan, "An approval is waiting.", false), {
    kind: "attention_pulse", candidateIds: [], dedupeKey: "digest_1",
  });
  assert.deepEqual(attentionPulseDeliveryConfirmation(plan, "Handled the follow-up.", true), {
    kind: "attention_pulse", candidateIds: ["candidate_1"], dedupeKey: "digest_1",
  });
  assert.equal(attentionPulseDeliveryConfirmation(plan, "NO_ACTION", false), undefined);
});

test("attention pulse cannot suppress a new observation and only checkpoints it after delivery", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910020;
  const now = Date.UTC(2026, 8, 30, 12);
  const observation = await createAttentionRecord(userId, "observation", {
    source: "watch:gmail", eventType: "watch.changed", summary: "A customer message needs a reply",
    entityId: "watch_inbox", dedupeKey: "watch-change-once", occurredAt: now,
    importance: 0.9, novelty: 0.8, confidence: 0.8, privacyScope: "private", status: "new",
  });
  const plan = await buildAttentionPulsePlan(userId, now);

  assert.equal(plan.mustReport, true);
  assert.equal(plan.observationIds.includes(observation.id), true);
  assert.match(plan.prompt, /A customer message needs a reply/);
  assert.match(plan.prompt, /not a claim that all mail, apps, calendars/);
  assert.match(attentionPulseCloseoutOutput(plan, "NO_ACTION"), /saved update/);
  assert.match(attentionPulseCloseoutOutput(plan, "Nothing needs attention."), /A customer message needs a reply/);
  assert.equal(attentionPulseDeliveryConfirmation(plan, "NO_ACTION", false), undefined);

  const confirmation = attentionPulseDeliveryConfirmation(plan, attentionPulseCloseoutOutput(plan, "NO_ACTION"), false);
  assert.deepEqual(confirmation?.observationIds, [observation.id]);
  assert.equal((await listAttentionRecords(userId, "observation") as any[])[0]?.status, "new");
  await markAttentionPulseDelivered(userId, [], now, confirmation?.observationIds);
  assert.equal((await listAttentionRecords(userId, "observation") as any[])[0]?.status, "processed");
});

test("attention pulse creates an owner-visible capability suggestion when no apps are connected", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910023;
  const now = Date.UTC(2026, 8, 30, 12);
  const plan = await buildAttentionPulsePlan(userId, now, {
    connectedAccounts: [],
    connectedAccountsVerified: true,
  });

  assert.equal(plan.hasWork, true);
  assert.equal(plan.mustReport, true);
  assert.match(plan.prompt, /Connect Gmail/);
  assert.match(plan.prompt, /what the missing connection would unlock/);
  assert.match(plan.fallbackDigest ?? "", /inbox reviews/);
  const candidates = await listAttentionRecords(userId, "attention_candidate") as any[];
  assert.equal(candidates.filter((candidate) => candidate.reason.startsWith("[connection-gap:")).length, 3);
  assert.equal(candidates.every((candidate) => candidate.suggestedActions?.some((action: { label: string }) => action.label === "Connect app")), true);

  const second = await buildAttentionPulsePlan(userId, now, {
    connectedAccounts: [],
    connectedAccountsVerified: true,
  });
  assert.equal((await listAttentionRecords(userId, "attention_candidate") as any[]).length, candidates.length);
  assert.equal(second.candidateIds.length, plan.candidateIds.length);
});

test("attention pulse reveals the next capability suggestions after the first window is delivered", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910025;
  const discovery = { connectedAccounts: [], connectedAccountsVerified: true } as const;
  const first = await buildAttentionPulsePlan(userId, Date.now(), discovery);
  assert.equal(first.candidateIds.length, 3);
  await markAttentionPulseDelivered(userId, first.candidateIds, Date.now());
  const second = await buildAttentionPulsePlan(userId, Date.now() + 1, discovery);
  assert.equal(second.candidateIds.length, 3);
  const candidates = await listAttentionRecords(userId, "attention_candidate") as any[];
  assert.equal(new Set(candidates.filter((candidate) => candidate.reason.startsWith("[connection-gap:")).map((candidate) => candidate.reason.match(/^\[connection-gap:([^\]]+)/)?.[1])).size, 6);
});

test("attention pulse resolves a pending capability suggestion after the app is connected", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910024;
  const now = Date.UTC(2026, 8, 30, 12);
  await buildAttentionPulsePlan(userId, now, { connectedAccounts: [], connectedAccountsVerified: true });
  await buildAttentionPulsePlan(userId, now + 1, {
    connectedAccounts: [{ toolkit: "GMAIL", status: "ACTIVE" }, { toolkit: "GOOGLECALENDAR", status: "ACTIVE" }],
    connectedAccountsVerified: true,
  });
  const candidates = await listAttentionRecords(userId, "attention_candidate") as any[];
  assert.equal(candidates.filter((candidate) => candidate.reason.startsWith("[connection-gap:gmail]") && candidate.status === "pending").length, 0);
  assert.equal(candidates.some((candidate) => candidate.reason.startsWith("[connection-gap:gmail]") && candidate.status === "dismissed"), true);
});

test("attention pulse reports skipped due checks and captures observations created during reconciliation", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910022;
  const now = Date.now();
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Calendar watch", domain: "calendar", objective: "Check for changed meetings", cadenceSeconds: 3600,
    authority: "observe", status: "active", maxItems: 10, nextCheckAt: now - 1000,
  });
  const plan = await buildAttentionPulsePlan(userId, now);
  assert.equal(plan.dueWatchIds.length, 1);
  const skipped = attentionPulseRequireDueWatchReport(plan, false);
  assert.match(attentionPulseCloseoutOutput(skipped, "NO_ACTION"), /no fresh read-back was recorded/);
  const freshPlan = { ...plan, mustReport: false, fallbackDigest: undefined, watchCoverage: plan.watchCoverage.map((watch) => ({ ...watch, status: "current" as const })) };
  assert.equal(attentionPulseCloseoutOutput(attentionPulseRequireDueWatchReport(freshPlan, true), "NO_ACTION"), "NO_ACTION");

  const observation = await createAttentionRecord(userId, "observation", {
    source: "watch:calendar", eventType: "watch.changed", summary: "The owner has a new meeting at 3 PM",
    entityId: plan.dueWatchIds[0], dedupeKey: "pulse-created-during-reconcile", occurredAt: now,
    importance: 0.9, novelty: 0.9, confidence: 0.8, privacyScope: "private", status: "new",
  }) as any;
  const refreshed = attentionPulseRefreshOwnerState(plan, plan.watchCoverage.map((watch) => ({ ...watch, status: "current" as const })), [observation]);
  assert.equal(refreshed.mustReport, true);
  assert.equal(refreshed.observationIds.includes(observation.id), true);
  assert.match(attentionPulseCloseoutOutput(refreshed, "NO_ACTION"), /new meeting at 3 PM/);
  assert.equal(attentionPulseRefreshOwnerState(plan, plan.watchCoverage.map((watch) => ({ ...watch, status: "current" as const })), []).mustReport, false);
});

test("attention pulse status shows configured watch coverage honestly", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910021;
  const now = Date.UTC(2026, 8, 30, 12);
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Gmail inbox", domain: "gmail", objective: "Check for new mail", cadenceSeconds: 3600,
    freshnessMs: 60_000, authority: "observe", status: "active", maxItems: 10,
    lastCheckedAt: now - 120_000, lastObservedAt: now - 120_000, nextCheckAt: now + 60_000,
  });
  const status = await configureAttentionPulse(userId, { action: "status" }) as any;
  assert.equal(status.watchCoverage.scope, "owner-configured watches plus bounded read-only starter watches for active connected apps; not an unrestricted provider sweep");
  assert.equal(status.watchCoverage.stale, 1);
  assert.equal(status.watchCoverage.watches[0].status, "stale");
});

test("attention pulse status does not report a paused schedule as enabled", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910026;
  await addJob(userId, {
    id: `pulse_${userId}`, userId, text: "Run the owner's proactive attention pulse.", cron: "0 * * * *",
    scheduleId: `chuck-attention-pulse-${userId}`, status: "paused", kind: "attention_pulse", createdAt: Date.now(),
  });
  const status = await configureAttentionPulse(userId, { action: "status" }) as { enabled: boolean; jobs: Array<{ status: string }> };
  assert.equal(status.enabled, false);
  assert.equal(status.jobs[0]?.status, "paused");
});

test("attention pulse executes Elena's real handle-or-delegate boundary", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910008;
  const result = await executeDelegation(userId, {
    worker: "elena",
    objective: "Review the overdue onboarding open loop and handle it or delegate it before preparing a digest.",
    context: {
      attentionPulse: true,
      toolCall: {
        name: "CHUCK_HANDOFF_SUBAGENT",
        args: {
          targetWorker: "aria",
          objective: "Review the onboarding open loop, identify the next milestone, and return a concrete owner handoff.",
          expectedOutput: "A concise onboarding handoff with the next action and blocker.",
        },
      },
    },
  });
  assert.equal(result.status, "success");
  assert.ok(result.toolCallsLog.some((entry) => entry.tool === "CHUCK_HANDOFF_SUBAGENT" && entry.status === "completed"));
  assert.ok((await listHandoffRecords(userId)).some((handoff) => handoff.to === "aria"));
});

test("attention pulse cannot be enabled from a shared conversation", async () => {
  await assert.rejects(
    () => configureAttentionPulse(910006, { action: "enable" }, { sharedConversation: true }),
    /private Chusky chat/,
  );
});

test("re-enabling an active pulse repairs a missing capped delivery preference", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910017;
  await addJob(userId, {
    id: `pulse_${userId}`, userId, text: "Run the owner's proactive attention pulse.", cron: "0 * * * *",
    scheduleId: `chuck-attention-pulse-${userId}`, status: "active", kind: "attention_pulse", createdAt: Date.now(),
  });

  const result = await configureAttentionPulse(userId, { action: "enable" });
  const preferences = await listAttentionRecords(userId, "delivery_preference") as DeliveryPreferenceRecord[];

  assert.equal((result as { id: string }).id, `pulse_${userId}`);
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0]?.provider, "telegram");
  assert.equal(preferences[0]?.enabled, true);
  assert.equal(preferences[0]?.mode, "immediate");
  assert.equal(preferences[0]?.maxPerDay, 4);
});

test("re-enabling a pulse preserves an existing owner delivery preference", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910018;
  await addJob(userId, {
    id: `pulse_${userId}`, userId, text: "Run the owner's proactive attention pulse.", cron: "0 * * * *",
    scheduleId: `chuck-attention-pulse-${userId}`, status: "active", kind: "attention_pulse", createdAt: Date.now(),
  });
  await createAttentionRecord(userId, "delivery_preference", {
    provider: "telegram", conversationId: String(userId), enabled: false, mode: "silent", maxPerDay: 1,
  });

  await configureAttentionPulse(userId, { action: "enable" });
  const preferences = await listAttentionRecords(userId, "delivery_preference") as DeliveryPreferenceRecord[];

  assert.equal(preferences.length, 1);
  assert.equal(preferences[0]?.enabled, false);
  assert.equal(preferences[0]?.mode, "silent");
  assert.equal(preferences[0]?.maxPerDay, 1);
});

test("attention pulse bounds context and deduplicates unchanged state", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910005;
  await createAttentionRecord(userId, "open_loop", { title: "Follow up with the launch partner", nextAction: "Send the approved overview" });
  await createAttentionRecord(userId, "attention_candidate", { candidateType: "nudge", score: 0.9, reason: "The launch partner is waiting for a reply" });
  await createAttentionRecord(userId, "standing_order", { name: "Keep launches moving", instruction: "Prepare routine next steps", authority: "prepare", scope: ["launch"] });
  const first = await buildAttentionPulsePlan(userId);
  const second = await buildAttentionPulsePlan(userId);
  assert.equal(first.hasWork, true);
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(first.prompt.length <= 12_000, true);
  assert.match(first.prompt, /Do not churn nextAction/);
  const record = (await listAttentionRecords(userId, "open_loop"))[0];
  if (record && "id" in record) await updateAttentionRecord(userId, "open_loop", record.id, { nextAction: "Book the partner review" });
  const changed = await buildAttentionPulsePlan(userId);
  assert.notEqual(changed.dedupeKey, first.dedupeKey);
});

test("attention pulse preserves a durable trigger recovery without creating duplicate follow-up work", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910016;
  const recovery = {
    candidateType: "act" as const, score: 1, status: "pending" as const,
    sourceTriggerEventId: "trigger-event-unnotified-1",
    reason: "A Gmail trigger finished, but no private delivery channel was available.",
    proposedAction: "Review the saved trigger result and notify the owner; never replay its external action.",
  };
  const first = await createAttentionRecord(userId, "attention_candidate", recovery);
  const replay = await createAttentionRecord(userId, "attention_candidate", recovery);
  assert.equal(first.id, replay.id);
  const plan = await buildAttentionPulsePlan(userId);
  assert.equal(plan.hasWork, true);
  assert.match(plan.prompt, /Review the saved trigger result and notify the owner/);
  assert.match(plan.prompt, /never replay its external action/);
});

test("attention pulse finds blocked durable work and due watches without waking paused or future work", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910009;
  const now = Date.now();
  const task = await createTask(userId, { title: "Recover the import", objective: "Finish the failed import", nextAction: "Check the source file" });
  await blockTask(userId, task.id, "The import needs attention", "Check the source file");
  const mission = await createMission(userId, { title: "Launch readiness", objective: "Finish readiness review", definitionOfDone: "All checks pass" });
  await repairMission(userId, mission.id, { reason: "A readiness check failed", nextAction: "Rerun the failed check" });
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Invoice status", domain: "billing", objective: "Check for overdue invoices", cadenceSeconds: 3600,
    authority: "observe", status: "active", nextCheckAt: now - 1000, maxItems: 10,
  });
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Future shipment", domain: "shipping", objective: "Check shipment status", cadenceSeconds: 3600,
    authority: "observe", status: "active", nextCheckAt: now + 60_000, maxItems: 10,
  });
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Business renewal", domain: "crm", objective: "Check renewal progress", cadenceSeconds: 3600,
    authority: "observe", status: "active", mode: "business", maxItems: 10,
  });
  const pausedMission = await createMission(userId, { title: "Paused work", objective: "Do not resume", definitionOfDone: "Owner decides" });
  await pauseMission(userId, pausedMission.id);

  const plan = await buildAttentionPulsePlan(userId, now);

  assert.equal(plan.hasWork, true);
  assert.match(plan.prompt, /Recover the import/);
  assert.match(plan.prompt, /Launch readiness/);
  assert.match(plan.prompt, /Invoice status/);
  assert.match(plan.prompt, /Business renewal/);
  assert.match(plan.prompt, /personal.*Invoice status|Invoice status.*personal/);
  assert.match(plan.prompt, /business.*Business renewal|Business renewal.*business/);
  assert.match(plan.prompt, /Future shipment .*scheduled/);
  const dueWatchSection = plan.prompt.split("\nDue autonomy watches:\n")[1]?.split("\nAutonomy profile state")[0] ?? "";
  assert.doesNotMatch(dueWatchSection, /Future shipment/);
  assert.doesNotMatch(plan.prompt, /Paused work/);
});

test("attention pulse reopens dedupe when a due watch's autonomy profile changes", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910010;
  const now = Date.UTC(2026, 8, 24, 12);
  const watch = await createAttentionRecord(userId, "autonomy_watch", {
    name: "Profile-gated check", domain: "billing", objective: "Check invoice status", cadenceSeconds: 3600,
    authority: "observe", status: "active", nextCheckAt: now - 1000, maxItems: 10,
  });
  const profile = await createAttentionRecord(userId, "autonomy_profile", { mode: "personal", enabled: false });
  const before = await buildAttentionPulsePlan(userId, now);
  assert.match(before.prompt, /personal: disabled/);
  await updateAttentionRecord(userId, "autonomy_profile", profile.id, { enabled: true });
  const after = await buildAttentionPulsePlan(userId, now);
  assert.notEqual(after.dedupeKey, before.dedupeKey);
  assert.match(after.prompt, /personal: enabled/);
  assert.equal(watch.status, "active");
  const nextUtcDay = await buildAttentionPulsePlan(userId, now + 24 * 60 * 60 * 1000);
  assert.notEqual(nextUtcDay.dedupeKey, after.dedupeKey);
});

test("attention pulse covers overdue work, trigger delivery, approvals, meetings, and failed automations safely", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910019;
  const now = Date.now();
  const queuedTask = await createTask(userId, { title: "Overdue report", objective: "Finish the report" });
  await updateTask(userId, queuedTask.id, { runAt: now - 60_000 });
  await createTriggerEvent({ eventId: "pulse-trigger-undelivered", userId, triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", summary: "private message contents must not enter the pulse prompt", status: "completed", notificationStatus: "unavailable", result: "private provider response", createdAt: now - 1000, updatedAt: now - 500 });
  const approval = await createApproval({ userId, toolSlug: "CHUCK_SEND_EMAIL", args: { secret: "do not include" }, request: "private approval text", history: [], model: "test/model", channelScope: "private" });
  await createApproval({ userId, toolSlug: "CHUCK_SEND_EMAIL", args: {}, request: "shared approval", history: [], model: "test/model", channelScope: "shared" });
  await saveCalendarMeetingPreparation(userId, {
    id: "cmp_pulse_upcoming", userId, sourceTriggerEventId: "calendar-trigger-pulse", lifecycle: "created", status: "prepared",
    title: "Quarterly planning", startAt: new Date(now + 30 * 60_000).toISOString(), participants: [], createdAt: now, updatedAt: now,
  });
  await addRecallMeeting(userId, {
    id: "mtg_pulse_followthrough", userId, platform: "zoom", status: "ended", meetingUrlHash: "a".repeat(64), history: [],
    outcomeStatus: "pending", title: "Customer review", createdAt: now - 60_000, updatedAt: now - 30_000,
  });
  const jobId = `job_pulse_failure_${userId}`;
  await addJob(userId, { id: jobId, userId, text: "Review shipment exceptions", cron: "0 * * * *", scheduleId: `schedule_${userId}`, status: "active", createdAt: now - 86_400_000 });
  await createJobOccurrence({ id: "occ_pulse_failure", userId, jobId, occurrenceId: "run_1", status: "failed", mode: "act", idempotencyKey: "run_1", error: "provider unavailable", createdAt: now - 1000, updatedAt: now - 500, version: 0 });
  await addReminder(userId, { id: "rem_pulse_failure", userId, text: "Send the launch follow-up", runAt: now - 60_000, status: "failed", deliveryError: "delivery unavailable", createdAt: now - 120_000 });

  const plan = await buildAttentionPulsePlan(userId, now);

  assert.equal(plan.hasWork, true);
  assert.match(plan.prompt, /Overdue report/);
  assert.match(plan.prompt, /GMAIL_NEW_GMAIL_MESSAGE/);
  assert.match(plan.prompt, /without claiming its contents or replaying the event/);
  assert.match(plan.prompt, new RegExp(approval.id));
  assert.match(plan.prompt, /Quarterly planning/);
  assert.match(plan.prompt, /Customer review/);
  assert.match(plan.prompt, /Review shipment exceptions/);
  assert.match(plan.prompt, /Send the launch follow-up/);
  assert.doesNotMatch(plan.prompt, /private message contents|private provider response|private approval text|shared approval|do not include/);
  assert.ok(plan.decisionContext.items.some((item) => item.kind === "operational_signal" && item.id === `trigger:pulse-trigger-undelivered`));
});
