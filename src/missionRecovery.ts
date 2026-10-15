import { randomUUID } from "node:crypto";
import {
  acquireMissionRecoveryLease,
  blockMission,
  claimMissionAutomaticRepair,
  getMission,
  getMissionRecoveryMissionCursor,
  getMissionRecoveryOwnerCursor,
  listMissionOwnerIds,
  listMissions,
  listTasks,
  quarantineExpiredTask,
  releaseMissionRecoveryLease,
  renewMissionRecoveryLease,
  setMissionRecoveryMissionCursor,
  setMissionRecoveryOwnerCursor,
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
  /** Set when another process currently owns the distributed sweep lease. */
  skippedDueToLock?: boolean;
  /** Set when this process could not renew the lease and stopped advancing cursors. */
  leaseLost?: boolean;
}

export interface MissionRecoveryOptions {
  maxOwners?: number;
  maxMissionsPerOwner?: number;
  now?: number;
  /** Internal lease guard used by the process-wide sweeper before cursor writes. */
  shouldPersistCursor?: () => boolean;
  /** Internal fencing token; cursor updates are atomic with lease ownership checks. */
  recoveryLeaseToken?: string;
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
  const activeMissions = (await listMissions(userId))
    .filter((mission) => ["running", "waiting", "failed"].includes(mission.status))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const maxMissions = Math.max(1, Math.floor(options.maxMissionsPerOwner ?? 100));
  const missionCursor = await getMissionRecoveryMissionCursor(userId);
  const cursorIndex = missionCursor ? activeMissions.findIndex((mission) => mission.id > missionCursor) : 0;
  const startIndex = cursorIndex < 0 ? 0 : cursorIndex;
  const missions = activeMissions.length <= maxMissions
    ? activeMissions
    : Array.from({ length: maxMissions }, (_, index) => activeMissions[(startIndex + index) % activeMissions.length]!);
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
  if (missions.length && (options.shouldPersistCursor?.() ?? true)) {
    const persisted = await setMissionRecoveryMissionCursor(userId, missions[missions.length - 1]!.id, options.recoveryLeaseToken);
    if (!persisted) report.errors++;
  }
  return report;
}

/**
 * Process-wide sweeper entry point. A Redis lease protects the shared cursors;
 * round-robin cursors prevent fixed batch limits from starving owners or older
 * active missions. The lease is renewed while a slow provider enqueue runs.
 */
export async function recoverAllMissions(enqueue: MissionTaskEnqueuer, options: MissionRecoveryOptions = {}): Promise<MissionRecoveryReport> {
  const token = randomUUID();
  const total: MissionRecoveryReport = { ownersScanned: 0, missionsScanned: 0, repaired: 0, republished: 0, timerWakes: 0, quarantined: 0, blocked: 0, errors: 0 };
  const leaseSeconds = 120;
  if (!await acquireMissionRecoveryLease(token, leaseSeconds)) return { ...total, skippedDueToLock: true };

  let leaseLost = false;
  let renewalInFlight: Promise<void> | undefined;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || leaseLost) return;
    renewalInFlight = (async () => {
      try {
        if (!await renewMissionRecoveryLease(token, leaseSeconds)) leaseLost = true;
      } catch (error) {
        leaseLost = true;
        logger.warn({ errorClass: error instanceof Error ? error.name : "unknown" }, "Mission recovery lease renewal failed");
      }
    })().finally(() => { renewalInFlight = undefined; });
  }, 30_000);
  if (typeof renewalTimer === "object" && "unref" in renewalTimer) renewalTimer.unref();

  try {
    const ownerIds = (await listMissionOwnerIds()).sort((left, right) => left - right);
    const maxOwners = Math.max(1, Math.floor(options.maxOwners ?? 1000));
    const ownerCursor = await getMissionRecoveryOwnerCursor();
    const cursorIndex = ownerCursor === undefined ? 0 : ownerIds.findIndex((userId) => userId > ownerCursor);
    const startIndex = cursorIndex < 0 ? 0 : cursorIndex;
    const owners = ownerIds.length <= maxOwners
      ? ownerIds
      : Array.from({ length: maxOwners }, (_, index) => ownerIds[(startIndex + index) % ownerIds.length]!);
    const countKeys = ["ownersScanned", "missionsScanned", "repaired", "republished", "timerWakes", "quarantined", "blocked", "errors"] as const;
    for (const userId of owners) {
      if (leaseLost) break;
      try {
        const report = await recoverMissionsForOwner(userId, enqueue, {
          ...options,
          shouldPersistCursor: () => !leaseLost,
          recoveryLeaseToken: token,
        });
        for (const key of countKeys) total[key] += report[key];
        if (report.errors && leaseLost) break;
      } catch (error) {
        total.errors++;
        logger.warn({ userId, errorClass: error instanceof Error ? error.name : "unknown" }, "Mission recovery failed for owner");
      }
      if (!leaseLost && !await setMissionRecoveryOwnerCursor(userId, token)) leaseLost = true;
    }
    if (leaseLost) total.leaseLost = true;
    return total;
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
    await releaseMissionRecoveryLease(token);
  }
}
