import { Client as QStashClient } from "@upstash/qstash";
import { config } from "./config.js";
import { listAllJobs } from "./store.js";
import { workflowFailureUrl } from "./triggerWorkflow.js";
import { workflowUrl } from "./nativeTools.js";
import type { JobRecord } from "./store.js";

export interface ScheduleReconciliationResult {
  checked: number;
  recreated: string[];
  deleted: string[];
  paused: string[];
  resumed: string[];
  unchanged: string[];
}

export interface ScheduleSweepResult extends ScheduleReconciliationResult {
  owners: number;
  failures: Array<{ userId: number; error: string }>;
}

interface ScheduleLike { scheduleId: string; cron: string; destination: string; isPaused?: boolean; }
interface ReconciliationDependencies {
  jobs: () => Promise<JobRecord[]>;
  schedules: () => Promise<ScheduleLike[]>;
  create: (job: JobRecord) => Promise<void>;
  pause: (scheduleId: string) => Promise<void>;
  resume: (scheduleId: string) => Promise<void>;
  remove: (scheduleId: string) => Promise<void>;
}

/** Repairs QStash schedule drift without trusting the provider as the source of truth.
 * Local job state remains authoritative: cancelled schedules are removed, active
 * schedules are recreated when missing or materially changed, and paused jobs
 * stay paused even when the provider has drifted. */
export async function reconcileUserSchedules(userId: number, overrides?: Partial<ReconciliationDependencies>): Promise<ScheduleReconciliationResult> {
  let client: QStashClient | undefined;
  const qstash = () => client ??= new QStashClient({ token: config.qstashToken });
  const jobs = overrides?.jobs ?? (() => listAllJobs(userId));
  const schedules = overrides?.schedules ?? (async () => qstash().schedules.list());
  const create = overrides?.create ?? (async (job) => {
    await qstash().schedules.create({
      scheduleId: job.scheduleId,
      destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
      body: JSON.stringify({ jobId: job.id, userId }),
      headers: { "Content-Type": "application/json" },
      cron: job.cron,
      retries: 3,
      retryDelay: "1000 * (1 + retried)",
      ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
    });
  });
  const pause = overrides?.pause ?? ((scheduleId) => qstash().schedules.pause({ schedule: scheduleId }));
  const resume = overrides?.resume ?? ((scheduleId) => qstash().schedules.resume({ schedule: scheduleId }));
  const remove = overrides?.remove ?? ((scheduleId) => qstash().schedules.delete(scheduleId));
  const existing = new Map((await schedules()).map((schedule) => [schedule.scheduleId, schedule]));
  const result: ScheduleReconciliationResult = { checked: 0, recreated: [], deleted: [], paused: [], resumed: [], unchanged: [] };
  for (const job of await jobs()) {
    const schedule = existing.get(job.scheduleId);
    if (job.status === "cancelled") {
      if (schedule) { await remove(job.scheduleId); result.deleted.push(job.scheduleId); }
      continue;
    }
    result.checked++;
    if (job.status === "paused") {
      if (!schedule || schedule.cron !== job.cron) {
        await create(job);
        await pause(job.scheduleId);
        result.recreated.push(job.scheduleId);
        result.paused.push(job.scheduleId);
      } else if (!schedule.isPaused) {
        await pause(job.scheduleId);
        result.paused.push(job.scheduleId);
      } else result.unchanged.push(job.scheduleId);
      continue;
    }
    if (!schedule || schedule.cron !== job.cron || schedule.isPaused) {
      await create(job);
      result.recreated.push(job.scheduleId);
      if (schedule?.isPaused) {
        await resume(job.scheduleId);
        result.resumed.push(job.scheduleId);
      }
    } else result.unchanged.push(job.scheduleId);
  }
  return result;
}

/** Reconcile all durable job owners using one provider schedule snapshot. */
export async function reconcileAllUserSchedules(userIds: readonly number[], schedules?: ScheduleLike[]): Promise<ScheduleSweepResult> {
  const result: ScheduleSweepResult = { owners: userIds.length, checked: 0, recreated: [], deleted: [], paused: [], resumed: [], unchanged: [], failures: [] };
  if (!userIds.length) return result;
  let client: QStashClient | undefined;
  const qstash = () => client ??= new QStashClient({ token: config.qstashToken });
  const snapshot = schedules ?? await qstash().schedules.list();
  for (const userId of userIds) {
    try {
      const ownerResult = await reconcileUserSchedules(userId, { schedules: async () => snapshot });
      result.checked += ownerResult.checked;
      result.recreated.push(...ownerResult.recreated);
      result.deleted.push(...ownerResult.deleted);
      result.paused.push(...ownerResult.paused);
      result.resumed.push(...ownerResult.resumed);
      result.unchanged.push(...ownerResult.unchanged);
    } catch (error) {
      result.failures.push({ userId, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    }
  }
  return result;
}
