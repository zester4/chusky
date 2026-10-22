/**
 * Provider-neutral customer billing domain.
 *
 * This module deliberately does not charge a payment method. It owns the
 * state transitions and ledger invariants that a Stripe (or other payment
 * provider) adapter must satisfy later. Provider webhooks are reduced to
 * idempotent BillingEvents before they reach this state machine.
 */

export const BILLING_PLAN_IDS = ["hobby", "starter", "business", "growth", "scale"] as const;
export type BillingPlanId = (typeof BILLING_PLAN_IDS)[number];

export type BillingPlan = {
  id: BillingPlanId;
  name: string;
  monthlyPriceCents: number;
  users: number;
  activeMissions: number;
  agentActions: number;
  meetingHours: number;
  voiceMinutes: number;
  phoneNumbers: number;
};

/** The customer-facing launch catalogue. Keep this in one place so API,
 * checkout, entitlements, and billing tests cannot drift independently. */
export const BILLING_PLANS: Readonly<Record<BillingPlanId, BillingPlan>> = {
  hobby: { id: "hobby", name: "Hobby", monthlyPriceCents: 7_900, users: 1, activeMissions: 2, agentActions: 2_500, meetingHours: 1, voiceMinutes: 30, phoneNumbers: 1 },
  starter: { id: "starter", name: "Starter", monthlyPriceCents: 19_900, users: 1, activeMissions: 5, agentActions: 10_000, meetingHours: 3, voiceMinutes: 100, phoneNumbers: 1 },
  business: { id: "business", name: "Business", monthlyPriceCents: 44_900, users: 5, activeMissions: 50, agentActions: 50_000, meetingHours: 10, voiceMinutes: 300, phoneNumbers: 3 },
  growth: { id: "growth", name: "Growth", monthlyPriceCents: 89_900, users: 15, activeMissions: 200, agentActions: 200_000, meetingHours: 30, voiceMinutes: 1_000, phoneNumbers: 10 },
  scale: { id: "scale", name: "Scale", monthlyPriceCents: 149_900, users: 30, activeMissions: 500, agentActions: 500_000, meetingHours: 100, voiceMinutes: 3_000, phoneNumbers: 25 },
};

export type BillingSubscriptionStatus = "trialing" | "active" | "past_due" | "grace" | "suspended" | "canceled";

export type BillingSubscription = {
  id: string;
  userId: number;
  planId: BillingPlanId;
  status: BillingSubscriptionStatus;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  failedPaymentAttempts: number;
  lastProviderEventId?: string;
  /** Provider webhooks can arrive out of order. This is the monotonic event watermark. */
  lastProviderEventAt?: number;
  lastInvoiceId?: string;
  updatedAt: number;
  version: number;
};

export type BillingEventType =
  | "subscription_started"
  | "renewal_succeeded"
  | "payment_succeeded"
  | "payment_failed"
  | "cancel_at_period_end"
  | "subscription_canceled"
  | "subscription_reactivated";

export type BillingEvent = {
  id: string;
  type: BillingEventType;
  occurredAt: number;
  periodStart?: number;
  periodEnd?: number;
  invoiceId?: string;
  providerPaymentId?: string;
  failureCode?: string;
};

export type BillingTransitionResult = {
  subscription: BillingSubscription;
  applied: boolean;
  effect: "started" | "renewed" | "payment_recovered" | "payment_failed" | "cancel_scheduled" | "canceled" | "reactivated" | "ignored";
};

export const BILLING_FAILURE_POLICY = {
  /** The first failed attempt remains recoverable without suspension. */
  graceAfterAttempts: 1,
  /** Do not allow an unbounded dunning loop to keep external usage active. */
  suspendAfterAttempts: 3,
} as const;

export function billingPlan(id: BillingPlanId): BillingPlan {
  return BILLING_PLANS[id];
}

export function billingPlanCatalog(): BillingPlan[] {
  return BILLING_PLAN_IDS.map((id) => ({ ...BILLING_PLANS[id] }));
}

export function createBillingSubscription(input: {
  id: string;
  userId: number;
  planId: BillingPlanId;
  periodStart: number;
  periodEnd: number;
  status?: "trialing" | "active";
}): BillingSubscription {
  if (!/^sub_[A-Za-z0-9_-]{8,160}$/.test(input.id)) throw new Error("Billing subscription ID is invalid.");
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) throw new Error("Billing user ID is invalid.");
  if (!Number.isSafeInteger(input.periodStart) || !Number.isSafeInteger(input.periodEnd) || input.periodEnd <= input.periodStart) throw new Error("Billing period is invalid.");
  billingPlan(input.planId);
  const now = Date.now();
  return {
    id: input.id,
    userId: input.userId,
    planId: input.planId,
    status: input.status ?? "active",
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    cancelAtPeriodEnd: false,
    failedPaymentAttempts: 0,
    lastProviderEventAt: input.periodStart,
    updatedAt: now,
    version: 1,
  };
}

function eventPeriod(event: BillingEvent, current: BillingSubscription): Pick<BillingSubscription, "periodStart" | "periodEnd"> {
  const periodStart = event.periodStart ?? current.periodStart;
  const periodEnd = event.periodEnd ?? current.periodEnd;
  if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd) || periodEnd <= periodStart) throw new Error("Billing event contains an invalid period.");
  return { periodStart, periodEnd };
}

/**
 * Apply one provider-normalized event. The caller supplies the set of already
 * applied event IDs; this makes webhook retries harmless without storing raw
 * provider payloads in the billing state.
 */
export function applyBillingEvent(current: BillingSubscription, event: BillingEvent, appliedEventIds: ReadonlySet<string>): BillingTransitionResult {
  if (!event.id || event.id.length > 200) throw new Error("Billing event ID is invalid.");
  if (!Number.isSafeInteger(event.occurredAt)) throw new Error("Billing event timestamp is invalid.");
  if (appliedEventIds.has(event.id)) return { subscription: current, applied: false, effect: "ignored" };
  if (event.occurredAt < (current.lastProviderEventAt ?? 0)) return { subscription: current, applied: false, effect: "ignored" };

  const next: BillingSubscription = { ...current, updatedAt: Math.max(current.updatedAt, event.occurredAt), lastProviderEventId: event.id, lastProviderEventAt: event.occurredAt, version: current.version + 1 };
  let effect: BillingTransitionResult["effect"] = "ignored";
  switch (event.type) {
    case "subscription_started":
      if (current.status === "canceled") throw new Error("A canceled subscription must be reactivated explicitly.");
      next.status = current.status === "trialing" ? "trialing" : "active";
      effect = "started";
      break;
    case "renewal_succeeded":
      if (current.status === "canceled") return { subscription: current, applied: false, effect: "ignored" };
      Object.assign(next, eventPeriod(event, current));
      next.status = current.cancelAtPeriodEnd ? "canceled" : "active";
      next.failedPaymentAttempts = 0;
      if (event.invoiceId) next.lastInvoiceId = event.invoiceId;
      effect = "renewed";
      break;
    case "payment_succeeded":
      next.status = current.cancelAtPeriodEnd ? "canceled" : "active";
      next.failedPaymentAttempts = 0;
      if (event.invoiceId) next.lastInvoiceId = event.invoiceId;
      effect = "payment_recovered";
      break;
    case "payment_failed":
      next.failedPaymentAttempts = current.failedPaymentAttempts + 1;
      next.status = next.failedPaymentAttempts >= BILLING_FAILURE_POLICY.suspendAfterAttempts
        ? "suspended"
        : next.failedPaymentAttempts >= BILLING_FAILURE_POLICY.graceAfterAttempts
          ? "grace"
          : "past_due";
      if (event.invoiceId) next.lastInvoiceId = event.invoiceId;
      effect = "payment_failed";
      break;
    case "cancel_at_period_end":
      if (current.status === "canceled") return { subscription: current, applied: false, effect: "ignored" };
      next.cancelAtPeriodEnd = true;
      effect = "cancel_scheduled";
      break;
    case "subscription_canceled":
      next.status = "canceled";
      next.cancelAtPeriodEnd = false;
      effect = "canceled";
      break;
    case "subscription_reactivated":
      if (current.status === "canceled") throw new Error("A canceled subscription cannot be reactivated without a new provider subscription.");
      next.status = "active";
      next.cancelAtPeriodEnd = false;
      next.failedPaymentAttempts = 0;
      effect = "reactivated";
      break;
  }
  return { subscription: next, applied: true, effect };
}

export function subscriptionAllowsUsage(subscription: BillingSubscription): boolean {
  return subscription.status === "trialing" || subscription.status === "active" || subscription.status === "past_due" || subscription.status === "grace";
}

export function numberRentalIsBillable(input: { status: "active" | "released"; purchasedAt: number; releasedAt?: number; periodStart: number; periodEnd: number }): boolean {
  if (input.status !== "active") return false;
  if (!Number.isFinite(input.purchasedAt) || input.purchasedAt >= input.periodEnd) return false;
  return input.releasedAt === undefined || input.releasedAt > input.periodStart;
}

export function monthlyNumberChargeCents(input: { status: "active" | "released"; purchasedAt: number; releasedAt?: number; periodStart: number; periodEnd: number; customerPriceCents: number }): number {
  if (!numberRentalIsBillable(input)) return 0;
  if (!Number.isSafeInteger(input.customerPriceCents) || input.customerPriceCents < 0) throw new Error("Customer number price is invalid.");
  return input.customerPriceCents;
}

export function billingUsageSummary(input: { voiceMinutes: number; meetingMinutes: number; agentActions: number; planId: BillingPlanId }): {
  voiceMinutes: number;
  meetingMinutes: number;
  agentActions: number;
  included: BillingPlan;
  voiceOverageMinutes: number;
  meetingOverageMinutes: number;
  agentActionOverage: number;
} {
  const included = billingPlan(input.planId);
  return {
    voiceMinutes: Math.max(0, input.voiceMinutes),
    meetingMinutes: Math.max(0, input.meetingMinutes),
    agentActions: Math.max(0, input.agentActions),
    included,
    voiceOverageMinutes: Math.max(0, input.voiceMinutes - included.voiceMinutes),
    meetingOverageMinutes: Math.max(0, input.meetingMinutes - included.meetingHours * 60),
    agentActionOverage: Math.max(0, input.agentActions - included.agentActions),
  };
}
