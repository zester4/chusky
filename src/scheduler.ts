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
  unchanged: string[];
}

interface ScheduleLike { scheduleId: string; cron: string; destination: string; isPaused?: boolean; }
interface ReconciliationDependencies {
  jobs: () => Promise<JobRecord[]>;
  schedules: () => Promise<ScheduleLike[]>;
  create: (job: JobRecord) => Promise<void>;
  remove: (scheduleId: string) => Promise<void>;
}

/** Repairs QStash schedule drift without trusting the provider as the source of truth.
 * Cancelled jobs are deleted; active jobs are recreated when missing or materially changed. */
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
  const remove = overrides?.remove ?? ((scheduleId) => qstash().schedules.delete(scheduleId));
  const existing = new Map((await schedules()).map((schedule) => [schedule.scheduleId, schedule]));
  const result: ScheduleReconciliationResult = { checked: 0, recreated: [], deleted: [], unchanged: [] };
  for (const job of await jobs()) {
    const schedule = existing.get(job.scheduleId);
    if (job.status === "cancelled") {
      if (schedule) { await remove(job.scheduleId); result.deleted.push(job.scheduleId); }
      continue;
    }
    result.checked++;
    if (!schedule || schedule.cron !== job.cron || schedule.isPaused) {
      await create(job);
      result.recreated.push(job.scheduleId);
    } else result.unchanged.push(job.scheduleId);
  }
  return result;
}
