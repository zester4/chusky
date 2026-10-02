import {
  blockMission,
  claimMissionAutomaticRepair,
  getMission,
  listMissionOwnerIds,
  listMissions,
  listTasks,
  quarantineExpiredTask,
} from "./store.js";
import { reconcileMissionExecution, resumeMissionAndSchedule, type MissionTaskEnqueuer } from "./missionScheduler.js";

export interface MissionRecoveryReport {
  ownersScanned: number;
  missionsScanned: number;
  repaired: number;
  republished: number;
  timerWakes: number;
  quarantined: number;
  blocked: number;
  errors: number;
}

export interface MissionRecoveryOptions {
  maxOwners?: number;
  maxMissionsPerOwner?: number;
  now?: number;
}

function missionTasks(tasks: Awaited<ReturnType<typeof listTasks>>, missionId: string) {
  return tasks.filter((task) => task.missionId === missionId);
}

/**
 * Reconcile durable mission control state independently of provider delivery.
 * This is deliberately conservative: an expired in-flight lease is
 * quarantined and blocked because the provider may already have accepted the
 * action; only absent/queued/timer work is republished automatically.
 */
export async function recoverMissionsForOwner(
  userId: number,
  enqueue: MissionTaskEnqueuer,
  options: Omit<MissionRecoveryOptions, "maxOwners"> = {},
): Promise<MissionRecoveryReport> {
  const report: MissionRecoveryReport = { ownersScanned: 1, missionsScanned: 0, repaired: 0, republished: 0, timerWakes: 0, quarantined: 0, blocked: 0, errors: 0 };
  const now = options.now ?? Date.now();
  const missions = (await listMissions(userId)).filter((mission) => ["running", "waiting", "failed"].includes(mission.status)).slice(0, options.maxMissionsPerOwner ?? 100);
  report.missionsScanned = missions.length;
  for (const mission of missions) {
    try {
      const tasks = missionTasks(await listTasks(userId), mission.id);
      if (mission.status === "waiting") {
        if (mission.waiting?.kind !== "timer" || !mission.waiting.runAt || mission.waiting.runAt > now) continue;
        const resumed = await resumeMissionAndSchedule(userId, mission.id, enqueue);
        if (resumed?.status === "running") report.timerWakes++;
        if (resumed?.status === "running") report.repaired++;
        continue;
      }

      if (mission.status === "failed") {
        const failedTask = tasks.find((task) => task.status === "failed" && task.missionStepId && task.lastFailureClass === "no_progress");
        if (!failedTask) continue;
        // Only a server-classified no-progress failure is eligible. Provider
        // failures and uncertain outcomes remain manual recovery cases.
        const claimedRepair = await claimMissionAutomaticRepair(userId, failedTask.id);
        if (!claimedRepair) continue;
        const resumed = await resumeMissionAndSchedule(userId, mission.id, enqueue);
        if (resumed?.status === "running") report.repaired++;
        continue;
      }

      const expired = tasks.find((task) => task.status === "running" && task.lease && task.lease.expiresAt <= now);
      if (expired) {
        const reason = `Mission worker lease expired while step ${expired.missionStepId ?? "unknown"} was in flight. Provider outcome is uncertain; no automatic replay was attempted.`;
        const nextAction = "Inspect the provider receipt or read-back for this step, then repair or resume the mission explicitly.";
        const quarantined = await quarantineExpiredTask(userId, expired.id, reason, nextAction);
        if (quarantined) {
          await blockMission(userId, mission.id, reason, nextAction);
          report.quarantined++;
          report.blocked++;
        }
        continue;
      }

      const activeStepIds = new Set(mission.activeStepIds?.length ? mission.activeStepIds : mission.currentStepId ? [mission.currentStepId] : []);
      const needsScheduling = [...activeStepIds].some((stepId) => {
        const task = tasks.find((candidate) => candidate.missionStepId === stepId && !["completed", "cancelled"].includes(candidate.status));
        if (!task) return true;
        if (task.status !== "queued" || !task.workflowRunId || task.workflowRunId.startsWith("pending:")) return true;
        // A recently accepted publication is already the durable recovery
        // record. Do not publish it again merely because the sweeper ran.
        return typeof task.workflowPublishedAt === "number" && now - task.workflowPublishedAt >= 60_000;
      });
      if (activeStepIds.size && !needsScheduling) continue;

      const before = await getMission(userId, mission.id);
      const reconciled = await reconcileMissionExecution(userId, mission.id, enqueue);
      if (!reconciled) continue;
      const afterTasks = missionTasks(await listTasks(userId), mission.id);
      const published = afterTasks.some((task) => task.status === "queued" && typeof task.workflowRunId === "string" && !task.workflowRunId.startsWith("pending:"));
      if (published) report.republished++;
      if (!before || before.version !== reconciled.version || published) report.repaired++;
    } catch {
      report.errors++;
    }
  }
  return report;
}

/** Process-wide sweeper entry point. Owner IDs come from a durable index. */
export async function recoverAllMissions(enqueue: MissionTaskEnqueuer, options: MissionRecoveryOptions = {}): Promise<MissionRecoveryReport> {
  const ownerIds = (await listMissionOwnerIds()).slice(0, options.maxOwners ?? 1000);
  const total: MissionRecoveryReport = { ownersScanned: 0, missionsScanned: 0, repaired: 0, republished: 0, timerWakes: 0, quarantined: 0, blocked: 0, errors: 0 };
  for (const userId of ownerIds) {
    const report = await recoverMissionsForOwner(userId, enqueue, options);
    for (const key of Object.keys(total) as Array<keyof MissionRecoveryReport>) total[key] += report[key];
  }
  return total;
}
