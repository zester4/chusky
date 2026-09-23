import {
  listAttentionRecords,
  listCalendarMeetingPreparations,
  listJobs,
  listMissions,
  listReminders,
  listTasks,
  type AutonomyProfileRecord,
  type AutonomyWatchRecord,
  type MissionRecord,
  type ReminderRecord,
  type JobRecord,
  type TaskRecord,
  type OpenLoopRecord,
} from "../store.js";

export type AutonomyQueueKind = "task" | "mission" | "open_loop" | "reminder" | "job" | "watch" | "meeting";

export interface AutonomyQueueItem {
  id: string;
  kind: AutonomyQueueKind;
  title: string;
  status: string;
  source: string;
  priority: number;
  nextAction?: string;
  nextCheckAt?: number;
  blockedReason?: string;
  updatedAt: number;
}

export interface AutonomySnapshot {
  userId: number;
  mode: "personal" | "business";
  profile: AutonomyProfileRecord;
  watches: AutonomyWatchRecord[];
  queue: AutonomyQueueItem[];
  counts: Record<AutonomyQueueKind, number> & { blocked: number; overdue: number };
  generatedAt: number;
}

const DEFAULT_PROFILE = (userId: number, mode: "personal" | "business"): AutonomyProfileRecord => ({
  id: `profile_default_${mode}`,
  userId,
  mode,
  enabled: false,
  defaultAuthority: "observe",
  maxChecksPerDay: mode === "business" ? 240 : 48,
  maxAutonomousActionsPerDay: mode === "business" ? 60 : 12,
  notifyOn: "important",
  allowedDomains: [],
  deniedDomains: [],
  createdAt: 0,
  updatedAt: 0,
});

function priority(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function taskItem(task: TaskRecord): AutonomyQueueItem {
  return { id: task.id, kind: "task", title: task.title, status: task.status, source: "durable_task", priority: task.status === "blocked" ? 95 : 60, nextAction: task.nextAction ?? task.checkpoint, ...(task.status === "blocked" && task.error ? { blockedReason: task.error } : {}), ...(task.runAt ? { nextCheckAt: task.runAt } : {}), updatedAt: task.updatedAt };
}

function missionItem(mission: MissionRecord): AutonomyQueueItem {
  const blocked = mission.status === "blocked" || mission.status === "waiting";
  return { id: mission.id, kind: "mission", title: mission.title, status: mission.status, source: "durable_mission", priority: blocked ? 98 : 75, nextAction: mission.nextAction ?? mission.checkpoint, ...(blocked && mission.error ? { blockedReason: mission.error } : {}), ...(mission.waiting?.runAt ? { nextCheckAt: mission.waiting.runAt } : {}), updatedAt: mission.updatedAt };
}

function openLoopItem(loop: OpenLoopRecord): AutonomyQueueItem {
  return { id: loop.id, kind: "open_loop", title: loop.title, status: loop.status, source: loop.source ?? "attention_state", priority: priority(loop.priority, 50), nextAction: loop.nextAction, ...(loop.waitingFor ? { blockedReason: loop.waitingFor } : {}), ...(loop.dueAt ? { nextCheckAt: loop.dueAt } : {}), updatedAt: loop.updatedAt };
}

function reminderItem(reminder: ReminderRecord): AutonomyQueueItem {
  return { id: reminder.id, kind: "reminder", title: reminder.text, status: reminder.status, source: "reminder", priority: 55, nextAction: reminder.nextAction, nextCheckAt: reminder.runAt, updatedAt: reminder.createdAt };
}

function jobItem(job: JobRecord): AutonomyQueueItem {
  return { id: job.id, kind: "job", title: job.text, status: job.status, source: job.kind === "attention_pulse" ? "attention_pulse" : "recurring_job", priority: job.kind === "attention_pulse" ? 45 : 50, nextAction: job.nextAction, updatedAt: job.createdAt };
}

function isActiveStatus(status: string): boolean {
  return !["completed", "cancelled", "failed", "dismissed", "expired", "sent", "revoked", "archived"].includes(status);
}

/**
 * Build one bounded owner-scoped queue from every durable source. This is a
 * read-only projection: it never claims work or silently executes anything.
 */
export async function getAutonomyQueue(userId: number, mode: "personal" | "business" = "personal", limit = 100): Promise<AutonomyQueueItem[]> {
  const [tasks, missions, loops, reminders, jobs, watches, meetings] = await Promise.all([
    listTasks(userId),
    listMissions(userId),
    listAttentionRecords(userId, "open_loop", { limit: 200 }) as Promise<OpenLoopRecord[]>,
    listReminders(userId),
    listJobs(userId),
    listAttentionRecords(userId, "autonomy_watch", { limit: 200 }) as Promise<AutonomyWatchRecord[]>,
    listCalendarMeetingPreparations(userId, 30),
  ]);
  const items: AutonomyQueueItem[] = [
    ...tasks.filter((item) => isActiveStatus(item.status)).map(taskItem),
    ...missions.filter((item) => isActiveStatus(item.status)).map(missionItem),
    ...loops.filter((item) => isActiveStatus(item.status)).map(openLoopItem),
    ...reminders.filter((item) => isActiveStatus(item.status)).map(reminderItem),
    ...jobs.filter((item) => isActiveStatus(item.status)).map(jobItem),
    ...watches.filter((item) => item.status === "active").map((watch) => ({ id: watch.id, kind: "watch" as const, title: watch.name, status: watch.status, source: `watch:${watch.domain}`, priority: mode === "business" ? 65 : 50, nextAction: watch.objective, nextCheckAt: watch.nextCheckAt, ...(watch.lastError ? { blockedReason: watch.lastError } : {}), updatedAt: watch.updatedAt })),
    ...meetings.filter((item) => item.status === "prepared").map((meeting) => ({ id: meeting.id, kind: "meeting" as const, title: meeting.title ?? "Prepared meeting", status: meeting.status, source: "calendar_preparation", priority: 80, nextAction: "Review the private meeting brief and decide whether to join", ...(meeting.startAt && Number.isFinite(Date.parse(meeting.startAt)) ? { nextCheckAt: Date.parse(meeting.startAt) } : {}), updatedAt: meeting.updatedAt })),
  ];
  const now = Date.now();
  return items.sort((a, b) => {
    const aBlocked = a.blockedReason ? 1 : 0;
    const bBlocked = b.blockedReason ? 1 : 0;
    const aOverdue = a.nextCheckAt !== undefined && a.nextCheckAt <= now ? 1 : 0;
    const bOverdue = b.nextCheckAt !== undefined && b.nextCheckAt <= now ? 1 : 0;
    return bBlocked - aBlocked || bOverdue - aOverdue || b.priority - a.priority || (a.nextCheckAt ?? Number.MAX_SAFE_INTEGER) - (b.nextCheckAt ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt;
  }).slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
}

export async function getAutonomySnapshot(userId: number, mode: "personal" | "business" = "personal", profileOverrides: Partial<Pick<AutonomyProfileRecord, "enabled" | "defaultAuthority" | "quietHoursUtc" | "maxChecksPerDay" | "maxAutonomousActionsPerDay" | "notifyOn" | "allowedDomains" | "deniedDomains">> = {}): Promise<AutonomySnapshot> {
  const [profiles, watches, queue] = await Promise.all([
    listAttentionRecords(userId, "autonomy_profile", { limit: 50 }) as Promise<AutonomyProfileRecord[]>,
    listAttentionRecords(userId, "autonomy_watch", { limit: 200 }) as Promise<AutonomyWatchRecord[]>,
    getAutonomyQueue(userId, mode, 100),
  ]);
  const profile = { ...(profiles.find((item) => item.mode === mode) ?? DEFAULT_PROFILE(userId, mode)), ...profileOverrides };
  const counts = { task: 0, mission: 0, open_loop: 0, reminder: 0, job: 0, watch: 0, meeting: 0, blocked: 0, overdue: 0 } as AutonomySnapshot["counts"];
  const now = Date.now();
  for (const item of queue) {
    counts[item.kind] += 1;
    if (item.blockedReason) counts.blocked += 1;
    if (item.nextCheckAt !== undefined && item.nextCheckAt <= now) counts.overdue += 1;
  }
  return { userId, mode, profile, watches: watches.filter((item) => item.status === "active"), queue, counts, generatedAt: now };
}
