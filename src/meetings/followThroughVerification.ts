export interface MeetingFollowThroughItem { id: string; required: boolean; status: "planned" | "scheduled" | "sent" | "verified" | "failed" | "ambiguous"; receiptId?: string; dueAt?: number; }

export interface MeetingFollowThroughReport { status: "verified" | "pending" | "blocked"; missing: string[]; ambiguous: string[]; overdue: string[]; }

/** Fail closed when a meeting promise has no durable receipt or is ambiguous. */
export function verifyMeetingFollowThrough(items: readonly MeetingFollowThroughItem[], now = Date.now()): MeetingFollowThroughReport {
  const missing: string[] = []; const ambiguous: string[] = []; const overdue: string[] = [];
  for (const item of items) {
    if (item.required && ["planned", "scheduled"].includes(item.status)) missing.push(item.id);
    if (item.status === "ambiguous") ambiguous.push(item.id);
    if (item.dueAt !== undefined && item.dueAt < now && !["sent", "verified"].includes(item.status)) overdue.push(item.id);
  }
  return { status: ambiguous.length ? "blocked" : missing.length || overdue.length ? "pending" : "verified", missing, ambiguous, overdue };
}
