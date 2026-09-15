export type CalendarAutomationStatus =
  | "scheduled" | "creating" | "joining" | "waiting_room" | "in_call" | "leaving" | "ended" | "failed";

export interface CalendarAutoJoinPlanInput {
  enabled: boolean;
  lifecycle: "created" | "updated" | "sync" | "starting_soon" | "attendee_response" | "cancelled";
  meetingUrlHash?: string;
  startAt?: string;
  endAt?: string;
  nowMs?: number;
  existing?: {
    automatic: boolean;
    meetingUrlHash: string;
    joinAt?: string;
    status: CalendarAutomationStatus;
  };
}

export type CalendarAutoJoinPlan =
  | { action: "skip"; reason: "disabled" | "not-automatic" | "invalid-time" | "expired" | "missing-link" | "too-far" }
  | { action: "cancel" }
  | { action: "keep" }
  | { action: "schedule" | "reschedule"; joinAt?: string };

const ACTIVE_STATUSES = new Set<CalendarAutomationStatus>(["creating", "scheduled", "joining", "waiting_room", "in_call", "leaving"]);

/**
 * Pure, side-effect-free policy for reconciling one owner-opted-in calendar
 * meeting. Event payloads cannot switch this policy on; only the owner profile
 * supplies `enabled`.
 */
export function planCalendarAutoJoin(input: CalendarAutoJoinPlanInput): CalendarAutoJoinPlan {
  const existing = input.existing;
  const existingAutomatic = existing?.automatic === true && ACTIVE_STATUSES.has(existing.status);
  const cancel = (): CalendarAutoJoinPlan => existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "not-automatic" };

  // Never interrupt an active conversation, even if the organizer edits or
  // cancels the event while participants are still talking.
  if (existing?.automatic && (existing.status === "in_call" || existing.status === "leaving")) return { action: "keep" };
  if (input.lifecycle === "cancelled") return cancel();
  if (!input.enabled) return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "disabled" };
  // An attendee-response event is not a reliable signal that the owner
  // accepted the invitation. It may reconcile an existing bot, never create one.
  if (input.lifecycle === "attendee_response" && !existingAutomatic) return { action: "skip", reason: "not-automatic" };

  if (!input.meetingUrlHash || !/^[a-f0-9]{64}$/i.test(input.meetingUrlHash)) {
    return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "missing-link" };
  }
  const start = typeof input.startAt === "string" ? Date.parse(input.startAt) : NaN;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(start)) return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "invalid-time" };
  const end = typeof input.endAt === "string" ? Date.parse(input.endAt) : NaN;
  if (Number.isFinite(end) && end <= now) return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "expired" };
  if (start <= now - 60_000) return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "expired" };
  if (start > now + 30 * 24 * 60 * 60_000) return existingAutomatic ? { action: "cancel" } : { action: "skip", reason: "too-far" };

  // Recall reserves a bot only for `join_at` >= 10 minutes away. Closer
  // events are intentionally joined immediately, rather than sending an
  // invalid near-future schedule.
  const joinAt = start - now >= 10 * 60_000 ? new Date(start).toISOString() : undefined;
  if (existingAutomatic
    && existing!.meetingUrlHash === input.meetingUrlHash
    && (existing!.joinAt ?? undefined) === joinAt) return { action: "keep" };
  return { action: existingAutomatic ? "reschedule" : "schedule", ...(joinAt ? { joinAt } : {}) };
}
