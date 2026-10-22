import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBillingEvent,
  BILLING_FAILURE_POLICY,
  billingPlanCatalog,
  billingUsageSummary,
  createBillingSubscription,
  monthlyNumberChargeCents,
  numberRentalIsBillable,
  subscriptionAllowsUsage,
} from "../src/billing.js";

const periodStart = Date.parse("2026-10-01T00:00:00.000Z");
const periodEnd = Date.parse("2026-11-01T00:00:00.000Z");

function subscription() {
  return createBillingSubscription({ id: "sub_test_12345678", userId: 42, planId: "business", periodStart, periodEnd });
}

test("the launch catalogue exposes all five finalized bundle plans", () => {
  assert.deepEqual(billingPlanCatalog().map((plan) => [plan.id, plan.monthlyPriceCents]), [
    ["hobby", 7900], ["starter", 19900], ["business", 44900], ["growth", 89900], ["scale", 149900],
  ]);
});

test("renewal retries are idempotent and reset failed payment attempts", () => {
  let current = subscription();
  const applied = new Set<string>();
  const failed = applyBillingEvent(current, { id: "evt_failed_1", type: "payment_failed", occurredAt: periodEnd }, applied);
  current = failed.subscription;
  applied.add("evt_failed_1");
  assert.equal(current.status, "grace");
  assert.equal(current.failedPaymentAttempts, 1);

  const duplicate = applyBillingEvent(current, { id: "evt_failed_1", type: "payment_failed", occurredAt: periodEnd }, applied);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.subscription.failedPaymentAttempts, 1);

  const renewed = applyBillingEvent(current, { id: "evt_renewed_1", type: "renewal_succeeded", occurredAt: periodEnd, periodStart: periodEnd, periodEnd: Date.parse("2026-12-01T00:00:00.000Z"), invoiceId: "in_1" }, applied);
  assert.equal(renewed.subscription.status, "active");
  assert.equal(renewed.subscription.failedPaymentAttempts, 0);
  assert.equal(renewed.subscription.lastInvoiceId, "in_1");
});

test("repeated failures suspend usage after the configured threshold", () => {
  let current = subscription();
  const applied = new Set<string>();
  for (let attempt = 1; attempt <= BILLING_FAILURE_POLICY.suspendAfterAttempts; attempt += 1) {
    const id = `evt_failure_${attempt}`;
    current = applyBillingEvent(current, { id, type: "payment_failed", occurredAt: periodEnd + attempt }, applied).subscription;
    applied.add(id);
  }
  assert.equal(current.status, "suspended");
  assert.equal(subscriptionAllowsUsage(current), false);
});

test("scheduled cancellation completes at the end of the paid period", () => {
  const current = subscription();
  const scheduled = applyBillingEvent(current, { id: "evt_cancel", type: "cancel_at_period_end", occurredAt: Date.now() }, new Set());
  assert.equal(scheduled.subscription.cancelAtPeriodEnd, true);
  const renewed = applyBillingEvent(scheduled.subscription, { id: "evt_period_end", type: "renewal_succeeded", occurredAt: periodEnd, periodStart: periodEnd, periodEnd: periodEnd + 31 * 86_400_000 }, new Set(["evt_cancel"]));
  assert.equal(renewed.subscription.status, "canceled");
  assert.equal(subscriptionAllowsUsage(renewed.subscription), false);
});

test("released numbers never create a monthly charge after release", () => {
  assert.equal(numberRentalIsBillable({ status: "released", purchasedAt: periodStart, releasedAt: periodStart + 1, periodStart, periodEnd }), false);
  assert.equal(monthlyNumberChargeCents({ status: "released", purchasedAt: periodStart, releasedAt: periodStart + 1, periodStart, periodEnd, customerPriceCents: 299 }), 0);
  assert.equal(monthlyNumberChargeCents({ status: "active", purchasedAt: periodStart, periodStart, periodEnd, customerPriceCents: 299 }), 299);
});

test("older provider events cannot roll back newer billing state", () => {
  const current = subscription();
  const newer = applyBillingEvent(current, { id: "evt_newer", type: "payment_failed", occurredAt: current.periodStart + 10_000 }, new Set());
  const older = applyBillingEvent(newer.subscription, { id: "evt_older", type: "payment_succeeded", occurredAt: current.periodStart + 1_000 }, new Set(["evt_newer"]));
  assert.equal(older.applied, false);
  assert.equal(older.subscription.status, "grace");
  assert.equal(older.subscription.version, newer.subscription.version);
});

test("usage summary reports only overages and preserves included plan allowances", () => {
  const summary = billingUsageSummary({ planId: "business", voiceMinutes: 350, meetingMinutes: 720, agentActions: 50_001 });
  assert.equal(summary.voiceOverageMinutes, 50);
  assert.equal(summary.meetingOverageMinutes, 120);
  assert.equal(summary.agentActionOverage, 1);
  assert.equal(summary.included.monthlyPriceCents, 44_900);
});
