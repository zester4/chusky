import assert from "node:assert/strict";
import test from "node:test";
import { backfillMissionSnapshotToNeon, type MissionBackfillTarget } from "../src/missionBackfill.js";
import type { MissionEventRecord, MissionRecord } from "../src/store.js";
import type { DurableMissionEvent, DurableMissionRecord } from "../src/neonDurableState.js";

const ownerId = 9_990_001;

function mission(id = "mis_backfill_1"): MissionRecord {
  return { id, userId: ownerId, status: "running", version: 1, steps: [], events: [], createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001 } as unknown as MissionRecord;
}

function event(id: string, at: number): MissionEventRecord {
  return { id, type: "checkpointed", message: id, at };
}

class Target implements MissionBackfillTarget {
  migrated = false;
  rows = new Map<string, DurableMissionRecord>();
  histories = new Map<string, DurableMissionEvent[]>();
  marker?: { missionCount: number; eventCount: number; digest: string };
  corruptReadback = false;
  returnedIdentity?: { ownerUserId: number; missionId: string };

  async isMissionOwnerMigrated() { return this.migrated; }
  async listMissions(userId: number, limit: number, afterMissionId?: string) { return [...this.rows.values()].filter((row) => row.ownerUserId === userId && (!afterMissionId || row.missionId > afterMissionId)).sort((a, b) => a.missionId.localeCompare(b.missionId)).slice(0, limit); }
  async readMission(userId: number, id: string) { const row = this.rows.get(id); return row?.ownerUserId === userId ? row : undefined; }
  async createMission(record: DurableMissionRecord) {
    const imported = this.returnedIdentity ? { ...record, ...this.returnedIdentity } : record;
    if (!this.rows.has(record.missionId)) this.rows.set(record.missionId, structuredClone(record));
    return imported;
  }
  async appendMissionEvents(_userId: number, id: string, events: readonly DurableMissionEvent[]) {
    const history = this.histories.get(id) ?? [];
    const known = new Set(history.map((item) => item.id));
    history.push(...events.filter((item) => !known.has(item.id)).map((item) => structuredClone(item)));
    this.histories.set(id, history);
  }
  async listMissionEvents(_userId: number, id: string) {
    const events = this.histories.get(id) ?? [];
    return this.corruptReadback ? [...events, event("misleading", 9_000)] : events;
  }
  async markMissionOwnerMigrated(_userId: number, missionCount: number, eventCount: number, contentSha256: string) {
    this.marker = { missionCount, eventCount, digest: contentSha256 };
    this.migrated = true;
  }
}

function toDurableRecord(item: MissionRecord): DurableMissionRecord {
  return { ownerUserId: item.userId, missionId: item.id, status: item.status, payload: item as unknown as Record<string, unknown>, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

test("mission snapshot backfill verifies owner rows and ordered events before marking cutover", async () => {
  const target = new Target();
  const record = mission();
  const events = [event("evt_1", record.createdAt), event("evt_2", record.createdAt + 1)];
  const result = await backfillMissionSnapshotToNeon(ownerId, [record], new Map([[record.id, events]]), target, toDurableRecord);
  assert.deepEqual(result, { status: "migrated", missionCount: 1, eventCount: 2 });
  assert.deepEqual(target.histories.get(record.id), events);
  assert.equal(target.marker?.missionCount, 1);
  assert.equal(target.marker?.eventCount, 2);
  assert.match(target.marker?.digest ?? "", /^[a-f0-9]{64}$/);
});

test("mission snapshot backfill never marks cutover when event read-back differs", async () => {
  const target = new Target();
  target.corruptReadback = true;
  const record = mission();
  await assert.rejects(
    () => backfillMissionSnapshotToNeon(ownerId, [record], new Map([[record.id, [event("evt_1", record.createdAt)]]]), target, toDurableRecord),
    /failed read-back verification/,
  );
  assert.equal(target.marker, undefined);
  assert.equal(target.migrated, false);
});

test("mission snapshot backfill rejects a different Neon identity and remains resumable", async () => {
  const target = new Target();
  target.returnedIdentity = { ownerUserId: ownerId, missionId: "mis_other" };
  const record = mission();
  await assert.rejects(() => backfillMissionSnapshotToNeon(ownerId, [record], new Map(), target, toDurableRecord), /different Neon mission identity/);
  assert.equal(target.marker, undefined);
  assert.equal(target.migrated, false);
});

test("a completed migration is idempotently reported from Neon without rewriting rows", async () => {
  const target = new Target();
  const record = mission();
  target.rows.set(record.id, toDurableRecord(record));
  target.histories.set(record.id, [event("evt_1", record.createdAt)]);
  target.migrated = true;
  const result = await backfillMissionSnapshotToNeon(ownerId, [record], new Map(), target, toDurableRecord);
  assert.deepEqual(result, { status: "already_migrated", missionCount: 1, eventCount: 1 });
});

test("already-migrated owner inspection walks every keyset page", async () => {
  const target = new Target();
  target.migrated = true;
  for (let index = 0; index < 501; index += 1) {
    const record = mission(`mis_backfill_${String(index).padStart(4, "0")}`);
    target.rows.set(record.id, toDurableRecord(record));
  }
  const result = await backfillMissionSnapshotToNeon(ownerId, [], new Map(), target, toDurableRecord);
  assert.deepEqual(result, { status: "already_migrated", missionCount: 501, eventCount: 0 });
});
