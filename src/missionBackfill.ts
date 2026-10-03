import { createHash } from "node:crypto";
import type { MissionEventRecord, MissionRecord } from "./store.js";
import type { DurableMissionEvent, DurableMissionRecord } from "./neonDurableState.js";

export interface MissionBackfillTarget {
  isMissionOwnerMigrated(userId: number): Promise<boolean>;
  listMissions(userId: number, limit: number, afterMissionId?: string): Promise<DurableMissionRecord[]>;
  readMission(userId: number, missionId: string): Promise<DurableMissionRecord | undefined>;
  createMission(record: DurableMissionRecord, initialEvents: readonly DurableMissionEvent[]): Promise<DurableMissionRecord>;
  appendMissionEvents(userId: number, missionId: string, events: readonly DurableMissionEvent[]): Promise<void>;
  listMissionEvents(userId: number, missionId: string, limit: number): Promise<DurableMissionEvent[]>;
  markMissionOwnerMigrated(userId: number, missionCount: number, eventCount: number, contentSha256: string): Promise<void>;
}

export type MissionBackfillResult = { status: "migrated" | "already_migrated"; missionCount: number; eventCount: number };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function readAllMissions(target: MissionBackfillTarget, userId: number): Promise<DurableMissionRecord[]> {
  const records: DurableMissionRecord[] = [];
  let afterMissionId: string | undefined;
  for (;;) {
    const page = await target.listMissions(userId, 500, afterMissionId);
    records.push(...page);
    if (page.length < 500) return records;
    const lastId = page.at(-1)?.missionId;
    if (!lastId || lastId === afterMissionId) throw new Error("Mission owner pagination did not advance.");
    afterMissionId = lastId;
  }
}

export async function backfillMissionSnapshotToNeon(
  userId: number,
  missions: readonly MissionRecord[],
  eventsByMission: ReadonlyMap<string, readonly MissionEventRecord[]>,
  target: MissionBackfillTarget,
  toRecord: (mission: MissionRecord) => DurableMissionRecord,
  renewMigrationLease?: () => Promise<boolean>,
): Promise<MissionBackfillResult> {
  if (await target.isMissionOwnerMigrated(userId)) {
    const records = await readAllMissions(target, userId);
    const histories = await Promise.all(records.map((record) => target.listMissionEvents(userId, record.missionId, 5000)));
    return { status: "already_migrated", missionCount: records.length, eventCount: histories.reduce((sum, events) => sum + events.length, 0) };
  }

  const ordered = [...missions].sort((a, b) => a.id.localeCompare(b.id));
  if (ordered.some((mission) => mission.userId !== userId) || new Set(ordered.map((mission) => mission.id)).size !== ordered.length) {
    throw new Error("Mission snapshot contains an invalid or duplicate owner-scoped record.");
  }
  const snapshot = ordered.map((mission) => ({ mission, events: [...(eventsByMission.get(mission.id) ?? [])] }));
  const digest = createHash("sha256").update(stableJson(snapshot)).digest("hex");
  let eventCount = 0;

  for (const { mission, events } of snapshot) {
    if (renewMigrationLease && !await renewMigrationLease()) throw new Error("Mission migration lock was lost; owner cutover was not marked.");
    if (events.length > 5000) throw new Error("Mission history exceeds the bounded migration batch; owner cutover was not marked.");
    const record = toRecord(mission);
    const existing = await target.readMission(userId, mission.id);
    if (existing && stableJson(existing.payload) !== stableJson(record.payload)) {
      throw new Error("A mission already exists in Neon with different content; owner cutover was not marked.");
    }
    const imported = await target.createMission(record, []);
    if (imported.ownerUserId !== userId || imported.missionId !== mission.id) {
      throw new Error("Mission import conflicted with a different Neon mission identity; owner cutover was not marked.");
    }
    await target.appendMissionEvents(userId, mission.id, events as DurableMissionEvent[]);
    const stored = await target.readMission(userId, mission.id);
    const storedEvents = await target.listMissionEvents(userId, mission.id, 5000);
    if (!stored || stableJson(stored.payload) !== stableJson(record.payload) || stableJson(storedEvents) !== stableJson(events)) {
      throw new Error("Mission row or ordered history failed read-back verification; owner cutover was not marked.");
    }
    eventCount += events.length;
  }

  if (renewMigrationLease && !await renewMigrationLease()) throw new Error("Mission migration lock was lost before cutover; owner marker was not written.");
  await target.markMissionOwnerMigrated(userId, ordered.length, eventCount, digest);
  if (!await target.isMissionOwnerMigrated(userId)) throw new Error("Mission owner migration marker was not visible after commit.");
  return { status: "migrated", missionCount: ordered.length, eventCount };
}
