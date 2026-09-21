import test from "node:test";
import assert from "node:assert/strict";
import { attentionPulseDeliveredToday, attentionPulseDeliveryDecision, attentionPulseHasHandlingEvidence, buildAttentionPulsePlan, isWithinQuietHours, isNoActionPulseOutput, recordAttentionPulseDelivery } from "../src/attentionPulse.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { configureAttentionPulse } from "../src/nativeTools.js";
import { createAttentionRecord, initStore, listAttentionRecords, listHandoffRecords, updateAttentionRecord, type DeliveryPreferenceRecord } from "../src/store.js";
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
  assert.equal(attentionPulseHasHandlingEvidence([{ tool: "CHUCK_TASK_COMPLETE", status: "failed" }]), false);
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
