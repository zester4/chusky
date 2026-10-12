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
import { logger } from "./logger.js";

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

function expiredLeaseRecoveryText(task: Awaited<ReturnType<typeof listTasks>>[number]): { reason: string; nextAction: string } {
  const allowed = task.missionAllowedTools ?? [];
  const externalTools = allowed.filter((tool) => !tool.startsWith("CHUCK_"));
  if (allowed.length > 0 && externalTools.length === 0) {
    return {
      reason: `Mission worker lease expired while native-only step ${task.missionStepId ?? "unknown"} was in flight. No external provider tool was authorized for this step, so no provider receipt is expected; the saved checkpoint and task events remain the authoritative progress record.`,
      nextAction: "Review the saved checkpoint and task events, then repair or resume this same mission from the exact next action. Do not retry an external action that was not authorized.",
    };
  }
  return {
    reason: `Mission worker lease expired while step ${task.missionStepId ?? "unknown"} was in flight. Provider outcome is uncertain; no automatic replay was attempted.`,
    nextAction: "Inspect the provider receipt or read-back for this step, then repair or resume the mission explicitly.",
  };
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
  // Read the owner's task collection once per sweep. Loading it for every
  // mission makes recovery O(missions × tasks), which grows sharply for active
  // accounts with many long-running objectives.
  const tasksByMission = new Map<string, Awaited<ReturnType<typeof listTasks>>>();
  for (const task of await listTasks(userId)) {
    if (!task.missionId) continue;
    const tasks = tasksByMission.get(task.missionId) ?? [];
    tasks.push(task);
    tasksByMission.set(task.missionId, tasks);
  }
  report.missionsScanned = missions.length;
  const reconciledMissionIds = new Set<string>();
  const versionChangedMissionIds = new Set<string>();
  for (const mission of missions) {
    try {
      const tasks = tasksByMission.get(mission.id) ?? [];
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
        const { reason, nextAction } = expiredLeaseRecoveryText(expired);
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
      reconciledMissionIds.add(mission.id);
      if (!before || before.version !== reconciled.version) versionChangedMissionIds.add(mission.id);
    } catch (error) {
      report.errors++;
      logger.warn({ userId, missionId: mission.id, errorClass: error instanceof Error ? error.name : "unknown" }, "Mission recovery failed for mission");
    }
  }
  if (reconciledMissionIds.size) {
    const finalTasks = await listTasks(userId);
    for (const missionId of reconciledMissionIds) {
      const published = finalTasks.some((task) => task.missionId === missionId && task.status === "queued" && typeof task.workflowRunId === "string" && !task.workflowRunId.startsWith("pending:"));
      if (published) report.republished++;
      if (published || versionChangedMissionIds.has(missionId)) report.repaired++;
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
