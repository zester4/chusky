import assert from "node:assert/strict";
import test from "node:test";
import { durableSdkRunHash, DURABLE_SESSION_DOMAINS, NeonDurableState, type DurableMissionRecord } from "../src/neonDurableState.js";
import { DURABLE_SESSION_FORMAT, DurableSessionDocumentsIncompleteError, joinSessionDomains, mergeDurableSessionDomain, splitSessionDomains } from "../src/sessionDomains.js";
import type { UserSession } from "../src/store.js";

class FakeClient {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  failOnInsert = false;
  failOnMissionEventInsert = false;
  staleSessionDomainInsertOnce = false;
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failOnInsert && text.includes("INSERT INTO chusky_session_domain")) throw new Error("database unavailable");
    if (this.staleSessionDomainInsertOnce && text.includes("INSERT INTO chusky_session_domain")) {
      this.staleSessionDomainInsertOnce = false;
      return { rows: [] as never[] };
    }
    if (text.includes("SELECT version FROM chusky_session_domain")) return { rows: [{ version: 2 }] as never[] };
    if (text.startsWith("UPDATE chusky_session_domain")) return { rows: [{ version: 3 }] as never[] };
    if (this.failOnMissionEventInsert && text.includes("INSERT INTO chusky_mission_event")) throw new Error("mission event store unavailable");
    if (text.includes("INSERT INTO chusky_mission (") || text.includes("UPDATE chusky_mission SET")) {
      const [owner, id, status, idempotencyKey, payload, version, createdAt, updatedAt] = text.includes("UPDATE chusky_mission SET")
        ? [values?.[0], values?.[1], values?.[3], values?.[4], values?.[5], values?.[6], values?.[7], values?.[8]]
        : values ?? [];
      return { rows: [{ owner_user_id: owner, mission_id: id, status, idempotency_key: idempotencyKey, payload: JSON.parse(String(payload)), version, created_at: new Date(Number(createdAt)), updated_at: new Date(Number(updatedAt)) }] as never[] };
    }
    if (text.includes("UPDATE chusky_object_metadata")) return { rows: [{ object_id: String(values?.[1]) }] as never[] };
    if (text.includes("INSERT INTO chusky_object_metadata")) {
      const [owner, id, kind, key, status, contentType, size, sha256, encryptionVersion, expiresAt, metadata, createdAt, updatedAt] = values ?? [];
      return { rows: [{ owner_user_id: owner, object_id: id, object_kind: kind, object_key: key, lifecycle_status: status, content_type: contentType, size_bytes: size, sha256, encryption_version: encryptionVersion, retention_expires_at: expiresAt ? new Date(Number(expiresAt)) : null, metadata: JSON.parse(String(metadata)), created_at: new Date(Number(createdAt)), updated_at: new Date(Number(updatedAt)) }] as never[] };
    }
    return { rows: text.includes("INSERT INTO chusky_sdk_run") ? [{ run_id: "run_1" }] as never[] : text.includes("INSERT INTO chusky_session_domain") ? [{ version: values?.[3] === null || values?.[3] === undefined ? 1 : Number(values[3]) + 1 }] as never[] : text.includes("INSERT INTO chusky_conversation_message") ? [{ message_id: "msg_1" }] as never[] : [] as never[] };
  }
  release() { this.released = true; }
}

class FakePool {
  readonly client = new FakeClient();
  reads: unknown[] = [];
  calls: Array<{ text: string; values?: unknown[] }> = [];
  failRead = false;
  schemaDefinition = "";
  ended = false;
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (this.failRead) throw new Error("database unavailable");
    if (text.includes("INSERT INTO chusky_mission_owner_state")) return { rows: [{ owner_user_id: values?.[0] }] as never[] };
    if (text.includes("pg_get_constraintdef")) return { rows: this.schemaDefinition ? [{ definition: this.schemaDefinition }] as never[] : [] as never[] };
    if (text.includes("INSERT INTO chusky_object_metadata")) {
      const [owner, id, kind, key, status, contentType, size, sha256, encryptionVersion, expiresAt, metadata, createdAt, updatedAt] = values ?? [];
      return { rows: [{ owner_user_id: owner, object_id: id, object_kind: kind, object_key: key, lifecycle_status: status, content_type: contentType, size_bytes: size, sha256, encryption_version: encryptionVersion, retention_expires_at: expiresAt ? new Date(Number(expiresAt)) : null, metadata: JSON.parse(String(metadata)), created_at: new Date(Number(createdAt)), updated_at: new Date(Number(updatedAt)) }] as never[] };
    }
    if (text.includes("UPDATE chusky_object_metadata")) return { rows: [{ object_id: String(values?.[1]) }] as never[] };
    return { rows: this.reads as never[] };
  }
  async connect() { return this.client; }
  async end() { this.ended = true; }
}

function session(): UserSession {
  const now = Date.now();
  return {
    model: "test/model", history: [{ role: "user", content: "hello" }], totalMessages: 1, totalCost: 0,
    triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [{ id: "mem_1", category: "fact", key: "k", value: "v", confidence: 1, source: "test", sensitivity: "sensitive", status: "active", createdAt: now, updatedAt: now }],
    imageAssets: [{ id: "img_1", name: "image", r2Key: "owner/image", contentType: "image/png", sizeBytes: 1, createdAt: now, updatedAt: now }], summaries: ["summary"], approvals: [], sdkThreads: [{ id: "thr_1", externalId: "external", metadata: {}, history: [], runs: [{ id: "run_1", status: "completed", input: "private", output: "result", events: [], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now,
  };
}

function missionRecord(version = 0): DurableMissionRecord {
  const now = 1_800_000_000_000;
  const payload = {
    id: "mis_test_1", userId: 42, status: version ? "running" : "queued", version,
    steps: [{ id: "step-1", status: version ? "running" : "pending", dependsOn: [] }],
    events: [{ id: "misevt_test_1", type: "created", message: "Mission created", at: now }],
    createdAt: now, updatedAt: now,
  };
  return { ownerUserId: 42, missionId: payload.id, status: payload.status, idempotencyKey: "test-key", payload, version, createdAt: now, updatedAt: now };
}

test("Neon durable session domains write atomically and permit versioned partial writes", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, { domain }] as const));
  await state.writeSessionDomains(42, documents);
  assert.equal(pool.client.calls[0]?.text, "BEGIN");
  assert.equal(pool.client.calls[1]?.text, "SELECT pg_advisory_xact_lock($1::bigint)");
  assert.deepEqual(pool.client.calls[1]?.values, [42]);
  assert.equal(pool.client.calls.filter((call) => call.text.includes("INSERT INTO chusky_session_domain")).length, 5);
  assert.equal(pool.client.calls.filter((call) => call.text.includes("pg_advisory_xact_lock")).length, 1);
  assert.equal(pool.client.calls.at(-1)?.text, "COMMIT");
  assert.equal(pool.client.released, true);
  assert.deepEqual([...await state.writeSessionDomains(42, new Map([["conversation", { changed: true }]] as const), [], new Map([["conversation", 1]]))], [["conversation", 2]]);
  assert.equal(pool.client.calls.filter((call) => call.text.includes("pg_advisory_xact_lock")).length, 2);
  const compareAndSwap = pool.client.calls.at(-2)!;
  assert.match(compareAndSwap.text, /VALUES \(\$1, \$2, \$3::jsonb, 1, NOW\(\)\)/);
  assert.doesNotMatch(compareAndSwap.text, /WHERE \$4::integer IS NULL/);
  assert.match(compareAndSwap.text, /chusky_session_domain\.version = \$4/);
  assert.match(compareAndSwap.text, /RETURNING version/);
  assert.deepEqual(compareAndSwap.values?.[3], 1);
  await assert.rejects(() => state.writeSessionDomains(42, new Map([["unknown", {}]] as never)), /unknown domain/);
});

test("Neon durable session writes reject a stale expected version instead of overwriting newer data", async () => {
  const pool = new FakePool();
  pool.client.staleSessionDomainInsertOnce = true;
  const state = new NeonDurableState(pool as never);

  await assert.rejects(() => state.writeSessionDomains(42, new Map([["conversation", { changed: true }]] as const), [], new Map([["conversation", 1]])), /domain version conflict/);
  const statements = pool.client.calls.map((call) => call.text);

  assert.ok(statements.indexOf("SELECT pg_advisory_xact_lock($1::bigint)") < statements.findIndex((sql) => sql.includes("INSERT INTO chusky_session_domain")));
  assert.equal(statements.some((sql) => sql.startsWith("UPDATE chusky_session_domain")), false);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(pool.client.released, true);
});

test("durable domain merge combines independent edits and additive profile counters", () => {
  assert.deepEqual(mergeDurableSessionDomain(
    { left: "old", right: "old" },
    { left: "new", right: "old" },
    { left: "old", right: "new" },
    "conversation",
  ), { left: "new", right: "new" });
  assert.deepEqual(mergeDurableSessionDomain(
    { totalMessages: 10, totalCost: 2 },
    { totalMessages: 11, totalCost: 2.5 },
    { totalMessages: 12, totalCost: 3 },
    "profile",
  ), { totalMessages: 13, totalCost: 3.5 });
  assert.throws(() => mergeDurableSessionDomain(
    { setting: "old" }, { setting: "owner edit" }, { setting: "stale edit" }, "memories",
  ), /overlapping concurrent changes/);
});

test("durable SDK domain merge preserves independent concurrent thread additions", () => {
  const baseline = { sdkThreads: [] };
  const current = { sdkThreads: [{ id: "thr_current", metadata: {}, history: [], runs: [] }] };
  const desired = { sdkThreads: [{ id: "thr_desired", metadata: {}, history: [], runs: [] }] };

  assert.deepEqual(mergeDurableSessionDomain(baseline, current, desired, "sdk"), {
    sdkThreads: [current.sdkThreads[0], desired.sdkThreads[0]],
  });
});

test("durable session snapshots never leak into the Redis core payload", () => {
  const value = { ...session(), durableDomainSnapshots: { profile: { totalMessages: 1 } } } as UserSession & { durableDomainSnapshots: Record<string, unknown> };
  const { core } = splitSessionDomains(value);
  assert.equal("durableDomainSnapshots" in core, false);
});

test("Neon durable session-domain failures roll back and release the connection", async () => {
  const pool = new FakePool();
  pool.client.failOnInsert = true;
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, { domain }] as const));
  await assert.rejects(() => state.writeSessionDomains(42, documents), /database unavailable/);
  assert.ok(pool.client.calls.some((call) => call.text === "ROLLBACK"));
  assert.equal(pool.client.released, true);
});

test("Neon session writes extract SDK runs into rows in the same transaction", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const documents = new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, domain === "sdk" ? { sdkThreads: [{ id: "thr_1", runs: [] }] } : { domain }] as const));
  const run = { id: "run_1", status: "completed", input: "private", output: "result", events: [], createdAt: 1_000, updatedAt: 1_000 };
  await state.writeSessionDomains(42, documents, [{ threadId: "thr_1", runId: "run_1", payload: run }]);
  const calls = pool.client.calls;
  const sdkRunInsert = calls.findIndex((call) => call.text.includes("INSERT INTO chusky_sdk_run"));
  assert.ok(sdkRunInsert > 0);
  assert.ok(sdkRunInsert < calls.findIndex((call) => call.text === "COMMIT"));
  assert.deepEqual(calls[sdkRunInsert]?.values, [42, "thr_1", "run_1", JSON.stringify(run), 1_000, 1_000, null]);
});

test("Neon health verifies reachability and the core session schema", async () => {
  const pool = new FakePool();
  pool.schemaDefinition = "CHECK (domain IN ('profile', 'conversation', 'memories', 'assets', 'sdk'))";
  const state = new NeonDurableState(pool as never);
  const health = await state.healthStatus();
  assert.deepEqual(pool.reads, []);
  assert.equal(health.reachable, true);
  assert.equal(pool.calls.some((call) => call.text.includes("FROM chusky_session_domain LIMIT 0")), true);
  assert.deepEqual(health, { enabled: true, reachable: true, schemaReady: true });
});

test("Neon health separates database reachability from missing durable schema", async () => {
  const pool = new FakePool();
  pool.schemaDefinition = "CHECK (domain IN ('profile', 'conversation'))";
  const state = new NeonDurableState(pool as never);
  assert.deepEqual(await state.healthStatus(), { enabled: true, reachable: true, schemaReady: false });
});

test("Neon health reports unavailable state without leaking database errors", async () => {
  const pool = new FakePool();
  pool.failRead = true;
  const state = new NeonDurableState(pool as never);
  const health = await state.healthStatus();
  assert.equal(health.reachable, false);
  assert.deepEqual(health, { enabled: true, reachable: false, schemaReady: false });
});

test("Neon mission repository checks both canonical mission and event tables", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.assertMissionSchema();
  assert.match(pool.calls[0]?.text ?? "", /FROM chusky_mission LIMIT 0/);
  assert.match(pool.calls[1]?.text ?? "", /FROM chusky_mission_event LIMIT 0/);
  assert.match(pool.calls[2]?.text ?? "", /FROM chusky_mission_owner_state LIMIT 0/);
});

test("Neon mission listing uses a validated stable keyset cursor", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.listMissions(42, 250, "mis_cursor_1");
  assert.match(pool.calls[0]?.text ?? "", /mission_id > \$2\) ORDER BY mission_id LIMIT \$3/);
  assert.deepEqual(pool.calls[0]?.values, [42, "mis_cursor_1", 250]);
  await assert.rejects(() => state.listMissions(42, 250, "bad-cursor"), /pagination cursor is invalid/);
});

test("mission backfill can defer embedded events until the full ordered history is copied", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.createMission(missionRecord(), []);
  assert.equal(pool.client.calls.some((call) => call.text.includes("INSERT INTO chusky_mission_event")), false);
});

test("mission owner cutover marker accepts only verified digest metadata", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.markMissionOwnerMigrated(42, 2, 7, "a".repeat(64));
  assert.deepEqual(pool.calls[0]?.values, [42, 2, 7, "a".repeat(64)]);
  assert.match(pool.calls[0]?.text ?? "", /ON CONFLICT \(owner_user_id\) DO NOTHING/);
  await assert.rejects(() => state.markMissionOwnerMigrated(42, 2, 7, "not-a-digest"), /verification metadata is invalid/);
});

test("Neon mission creation atomically stores owner record and initial event", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const created = await state.createMission(missionRecord());
  assert.equal(created.missionId, "mis_test_1");
  assert.equal(pool.client.calls[0]?.text, "BEGIN");
  const insert = pool.client.calls.find((call) => call.text.includes("INSERT INTO chusky_mission ("))!;
  assert.match(insert.text, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(insert.values?.slice(0, 4), [42, "mis_test_1", "queued", "test-key"]);
  const eventInsert = pool.client.calls.find((call) => call.text.includes("INSERT INTO chusky_mission_event"))!;
  assert.match(eventInsert.text, /ON CONFLICT \(owner_user_id, mission_id, event_id\) DO NOTHING/);
  assert.equal(pool.client.calls.at(-1)?.text, "COMMIT");
  assert.equal(pool.client.released, true);
});

test("Neon mission CAS and new history events share one transaction", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const current = missionRecord();
  const next = missionRecord(1);
  const newEvent = { id: "misevt_test_2", type: "started", message: "Mission started", at: next.updatedAt };
  const saved = await state.compareAndUpdateMission(42, current.missionId, 0, next, [newEvent]);
  assert.equal(saved?.version, 1);
  const update = pool.client.calls.find((call) => call.text.includes("UPDATE chusky_mission SET"))!;
  assert.match(update.text, /WHERE owner_user_id = \$1 AND mission_id = \$2 AND version = \$3/);
  assert.deepEqual(update.values?.slice(0, 3), [42, "mis_test_1", 0]);
  assert.ok(pool.client.calls.findIndex((call) => call.text.includes("INSERT INTO chusky_mission_event")) < pool.client.calls.findIndex((call) => call.text === "COMMIT"));
  assert.equal(pool.client.released, true);
});

test("Neon mission creation rolls back when its event insert fails", async () => {
  const pool = new FakePool();
  pool.client.failOnMissionEventInsert = true;
  const state = new NeonDurableState(pool as never);
  await assert.rejects(() => state.createMission(missionRecord()), /mission event store unavailable/);
  assert.ok(pool.client.calls.some((call) => call.text === "ROLLBACK"));
  assert.equal(pool.client.released, true);
});

test("Neon object metadata is owner-scoped, idempotently created, and finalized only from pending state", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  const now = Date.now();
  const pending = {
    ownerUserId: 42, objectId: "obj_test_1", kind: "transcript_segment" as const,
    objectKey: "archive/42/meeting/segment.bin", status: "pending" as const,
    contentType: "application/octet-stream", sizeBytes: 128,
    encryptionVersion: "aes256gcm-v1", retentionExpiresAt: now + 60_000,
    metadata: { meetingId: "mtg_1" }, createdAt: now, updatedAt: now,
  };
  const created = await state.createObjectMetadata(pending);
  assert.equal(created.objectId, pending.objectId);
  assert.equal(created.ownerUserId, 42);
  assert.match(pool.calls[0]?.text ?? "", /ON CONFLICT \(owner_user_id, object_id\) DO NOTHING/);
  assert.deepEqual(pool.calls[0]?.values?.slice(0, 5), [42, "obj_test_1", "transcript_segment", "archive/42/meeting/segment.bin", "pending"]);

  assert.equal(await state.markObjectAvailable(42, "obj_test_1", "archive/42/staging/segment.bin", "archive/42/final/segment.bin", 128, "a".repeat(64), "aes256gcm-v1"), true);
  assert.match(pool.calls[1]?.text ?? "", /lifecycle_status = 'available', object_key = \$4/);
  assert.match(pool.calls[1]?.text ?? "", /lifecycle_status = 'pending' AND object_key = \$3/);
  assert.deepEqual(pool.calls[1]?.values, [42, "obj_test_1", "archive/42/staging/segment.bin", "archive/42/final/segment.bin", 128, "a".repeat(64), "aes256gcm-v1"]);

  await state.getObjectMetadata(43, "obj_test_1");
  assert.deepEqual(pool.calls.at(-1)?.values, [43, "obj_test_1"]);
  assert.match(pool.calls.at(-1)?.text ?? "", /WHERE owner_user_id = \$1 AND object_id = \$2/);
  await assert.rejects(() => state.createObjectMetadata({ ...pending, objectId: "obj_bad_key", objectKey: "archive/43/foreign.bin" }), /not owner-scoped/);
  await assert.rejects(() => state.markObjectAvailable(42, "obj_test_1", "archive/42/staging/segment.bin", "archive/42/final/segment.bin", 128, "not-a-hash"), /verification is invalid/);
  await assert.rejects(() => state.markObjectAvailable(42, "obj_test_1", "archive/43/staging/segment.bin", "archive/42/final/segment.bin", 128, "a".repeat(64)), /verification is invalid/);
});

test("Neon object deletion is a retryable owner-scoped tombstone transition", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);

  assert.equal(await state.markObjectDeleting(42, "obj_test_1"), true);
  assert.match(pool.calls[0]?.text ?? "", /lifecycle_status = 'deleting'/);
  assert.match(pool.calls[0]?.text ?? "", /owner_user_id = \$1 AND object_id = \$2 AND lifecycle_status IN \('pending','available','failed','deleting'\)/);
  assert.deepEqual(pool.calls[0]?.values, [42, "obj_test_1"]);

  assert.equal(await state.markObjectDeleted(42, "obj_test_1"), true);
  assert.match(pool.calls[1]?.text ?? "", /lifecycle_status = 'deleting'/);
  assert.match(pool.calls[1]?.text ?? "", /lifecycle_status = 'deleted'/);
  assert.deepEqual(pool.calls[1]?.values, [42, "obj_test_1"]);

  assert.equal(await state.markObjectFailed(42, "obj_upload_2"), true);
  assert.match(pool.calls[2]?.text ?? "", /lifecycle_status IN \('pending','available'\)/);
  assert.match(pool.calls[2]?.text ?? "", /lifecycle_status = 'failed'/);
  assert.deepEqual(pool.calls[2]?.values, [42, "obj_upload_2"]);

  assert.equal(await state.markExpiredObjectDeleting(42, "obj_expired", Date.now()), true);
  assert.match(pool.calls[3]?.text ?? "", /retention_expires_at <= to_timestamp\(\$3 \/ 1000\.0\)/);
  assert.match(pool.calls[3]?.text ?? "", /lifecycle_status IN \('pending','available','failed','deleting'\)/);
  assert.deepEqual(pool.calls[3]?.values?.slice(0, 2), [42, "obj_expired"]);
  await assert.rejects(() => state.markExpiredObjectDeleting(42, "obj_bad", Number.NaN), /claim is invalid/);
});

test("Neon expired-object inventory is bounded, ordered, and status-filtered", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.listExpiredObjectMetadata(Date.now(), 20);
  assert.match(pool.calls[0]?.text ?? "", /retention_expires_at <= to_timestamp\(\$1 \/ 1000\.0\)/);
  assert.match(pool.calls[0]?.text ?? "", /lifecycle_status IN \('pending','available','deleting','failed'\)/);
  assert.match(pool.calls[0]?.text ?? "", /ORDER BY retention_expires_at, owner_user_id, object_id\s+LIMIT \$2/);
  assert.deepEqual(pool.calls[0]?.values?.slice(1), [20]);
  await assert.rejects(() => state.listExpiredObjectMetadata(Date.now(), 501), /query bounds are invalid/);
});

test("object catalog startup assertion fails closed when migration 0008 is absent", async () => {
  const pool = new FakePool();
  pool.failRead = true;
  const state = new NeonDurableState(pool as never);
  await assert.rejects(() => state.assertObjectMetadataSchema(), /database unavailable/);
  assert.match(pool.calls[0]?.text ?? "", /FROM chusky_object_metadata LIMIT 0/);
});

test("durable session startup rejects a schema without the profile domain migration", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await assert.rejects(() => state.assertSessionSchema(), /missing required domains/);
  assert.equal(pool.calls.length, 3);
});

test("durable session startup accepts the current domain constraint", async () => {
  const pool = new FakePool();
  pool.schemaDefinition = "CHECK ((domain = ANY (ARRAY['profile'::text, 'conversation'::text, 'memories'::text, 'assets'::text, 'sdk'::text])))";
  const state = new NeonDurableState(pool as never);
  await state.assertSessionSchema();
  assert.equal(pool.calls.length, 3);
});

test("conversation writes are owner-scoped, batched, bounded, and idempotent", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.appendConversationMessages(42, [{ id: "msg_1", role: "user", content: "hello", createdAt: 1000 }]);
  const write = pool.calls[0]!;
  assert.match(write.text, /INSERT INTO chusky_conversation_message/);
  assert.match(write.text, /ON CONFLICT \(user_id, message_id\) DO NOTHING/);
  assert.deepEqual(write.values?.[0], 42);
  await state.appendConversationMessages(42, [{ id: "msg_1", role: "user", content: "hello", createdAt: 1000 }]);
  await assert.rejects(() => state.appendConversationMessages(42, [{ id: "bad id", role: "user", content: "x", createdAt: 1 }]), /invalid/);
  assert.equal(state.getMetrics().queryCount, 2);
});

test("recent and older conversation reads are bounded and use stable owner-scoped cursors", async () => {
  const pool = new FakePool();
  const at = new Date("2026-10-03T00:00:00.000Z");
  pool.reads = [{ message_id: "msg_1", role: "user", content: "hello", source_id: null, created_at: at }];
  const state = new NeonDurableState(pool as never);
  const recent = await state.readRecentConversation(42, 10_000);
  assert.equal(recent[0]?.id, "msg_1");
  assert.deepEqual(pool.calls[0]?.values, [42, 30]);
  assert.match(pool.calls[0]?.text ?? "", /ORDER BY created_at DESC, message_id DESC LIMIT \$2/);
  await state.readConversationBefore(42, { createdAt: at.getTime(), id: "msg_1" }, 10_000);
  assert.deepEqual(pool.calls[1]?.values, [42, at.getTime(), "msg_1", 100]);
  assert.match(pool.calls[1]?.text ?? "", /ORDER BY created_at DESC, message_id DESC LIMIT \$4/);
  await assert.rejects(() => state.readConversationBefore(42, { createdAt: -1, id: "msg_1" }), /cursor is invalid/);
});

test("Neon SDK run reads are owner- and thread-scoped and listing is bounded", async () => {
  const pool = new FakePool();
  const at = new Date("2026-10-03T00:00:00.000Z");
  pool.reads = [{ user_id: "42", thread_id: "thr_test", run_id: "run_test", payload: { id: "run_test", status: "completed", events: [] }, created_at: at, updated_at: at }];
  const state = new NeonDurableState(pool as never);

  const run = await state.readSdkRun(42, "thr_test", "run_test");
  assert.equal(run?.userId, 42);
  assert.equal(run?.payload && (run.payload as { id: string }).id, "run_test");
  assert.deepEqual(pool.calls[0]?.values, [42, "thr_test", "run_test"]);

  const listed = await state.listSdkRuns(42, "thr_test", 50_000);
  assert.equal(listed.length, 1);
  assert.match(pool.calls[1]?.text ?? "", /ORDER BY created_at ASC, run_id ASC LIMIT \$3/);
  assert.deepEqual(pool.calls[1]?.values, [42, "thr_test", 200]);
  pool.reads = [];
  assert.equal(await state.readSdkRun(42, "thr_test", "run_other"), undefined);
  assert.deepEqual(pool.calls[2]?.values, [42, "thr_test", "run_other"]);
  await assert.rejects(() => state.listSdkRuns(42, "bad", 50), /identity is invalid/);
});

test("Neon SDK run writes validate identity and use version-guarded updates", async () => {
  const pool = new FakePool();
  pool.reads = [{ run_id: "run_test" }];
  const state = new NeonDurableState(pool as never);
  const run = { id: "run_test", status: "running", events: [], createdAt: 1000, updatedAt: 1000 };
  await state.writeSdkRun(42, "thr_test", "run_test", run, 2);
  const write = pool.calls[0]!;
  assert.match(write.text, /INSERT INTO chusky_sdk_run/);
  assert.match(write.text, /ON CONFLICT \(user_id, run_id\) DO UPDATE/);
  assert.match(write.text, /WHERE chusky_sdk_run.thread_id = EXCLUDED.thread_id/);
  assert.match(write.text, /chusky_sdk_run\.version = \$7/);
  assert.deepEqual(write.values, [42, "thr_test", "run_test", JSON.stringify(run), 1000, 1000, 2]);
  pool.reads = [];
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_test", run, 1), /version conflict/);
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_other", run), /payload is invalid/);
  await assert.rejects(() => state.writeSdkRun(42, "thr_test", "run_test", { ...run, updatedAt: 999 }), /timestamps are invalid/);
});

test("SDK run content hashes ignore local version metadata but detect persisted changes", () => {
  const run = { id: "run_test", status: "running", events: [], updatedAt: 1_000, durableVersion: 4 };
  const hash = durableSdkRunHash(run);
  assert.equal(durableSdkRunHash({ ...run, durableVersion: 5, durablePayloadHash: "local-only" }), hash);
  assert.notEqual(durableSdkRunHash({ ...run, status: "completed" }), hash);
});

test("Neon SDK run records continue to support legacy CLI thread IDs", async () => {
  const pool = new FakePool();
  const at = new Date("2026-10-03T00:00:00.000Z");
  pool.reads = [{ user_id: "42", thread_id: "cli_thread_legacy", run_id: "run_cli_test", payload: { id: "run_cli_test", status: "queued", events: [] }, created_at: at, updated_at: at }];
  const state = new NeonDurableState(pool as never);
  const run = { id: "run_cli_test", status: "queued", events: [], createdAt: 1000, updatedAt: 1000 };
  await state.writeSdkRun(42, "cli_thread_legacy", "run_cli_test", run);
  assert.equal(pool.calls[0]?.values?.[1], "cli_thread_legacy");
  assert.equal((await state.listSdkRuns(42, "cli_thread_legacy"))[0]?.runId, "run_cli_test");
  assert.deepEqual(pool.calls[1]?.values, [42, "cli_thread_legacy", 100]);
});

test("Neon SDK run deletion is constrained to the owner and thread", async () => {
  const pool = new FakePool();
  const state = new NeonDurableState(pool as never);
  await state.deleteSdkRunsForThread(42, "thr_test");
  assert.match(pool.calls[0]?.text ?? "", /DELETE FROM chusky_sdk_run WHERE user_id = \$1 AND thread_id = \$2/);
  assert.deepEqual(pool.calls[0]?.values, [42, "thr_test"]);
});

test("session split leaves runs out of the SDK document and emits owner-thread run records", () => {
  const original = session();
  const { core, domains, sdkRuns } = splitSessionDomains(original, true);
  assert.equal((core as UserSession & { durableSessionFormat?: number }).durableSessionFormat, DURABLE_SESSION_FORMAT);
  assert.deepEqual(core.history, original.history.slice(-20));
  assert.deepEqual(core.memories, []);
  assert.deepEqual(core.imageAssets, []);
  assert.deepEqual(core.sdkThreads, []);
  assert.deepEqual(joinSessionDomains(core, domains).history, original.history.slice(-20));
  assert.deepEqual(domains.get("conversation"), { summaries: original.summaries });
  assert.deepEqual(joinSessionDomains(core, domains).memories, original.memories);
  assert.deepEqual((domains.get("sdk") as { sdkThreads: Array<{ runs: unknown[] }> }).sdkThreads[0]?.runs, []);
  assert.deepEqual(sdkRuns, [{ threadId: "thr_1", run: original.sdkThreads![0]!.runs[0] }]);
  assert.deepEqual(joinSessionDomains(core, domains).sdkThreads?.[0]?.runs, []);
  const incompleteDomains = new Map(domains);
  incompleteDomains.delete("assets");
  assert.throws(
    () => joinSessionDomains(core, incompleteDomains),
    (error) => {
      assert.ok(error instanceof DurableSessionDocumentsIncompleteError);
      assert.deepEqual(error.missingDomains, ["assets"]);
      return true;
    },
  );
});

test("session-domain writes retain embedded SDK runs until per-run cutover is enabled", () => {
  const original = session();
  const { domains, sdkRuns } = splitSessionDomains(original);
  assert.deepEqual(sdkRuns, []);
  assert.deepEqual((domains.get("sdk") as { sdkThreads: Array<{ runs: unknown[] }> }).sdkThreads[0]?.runs, original.sdkThreads![0]!.runs);
});

test("Redis session split contains only the 20-message hot window and Neon profile reconstructs preferences", () => {
  const original = session();
  original.history = Array.from({ length: 45 }, (_, index) => ({ id: `msg_${index}`, role: index % 2 ? "assistant" as const : "user" as const, content: `message ${index}`, createdAt: index + 1 }));
  original.model = "preferred/model";
  original.voiceReplies = true;
  const { core, domains } = splitSessionDomains(original, true);
  assert.equal(core.history.length, 20);
  assert.equal(core.history[0]?.id, "msg_25");
  assert.deepEqual((domains.get("conversation") as { history?: unknown }).history, undefined);
  assert.deepEqual(joinSessionDomains(core, domains).history.map((message) => message.id), original.history.slice(-20).map((message) => message.id));
  assert.equal(joinSessionDomains(core, domains).model, "preferred/model");
  assert.equal(joinSessionDomains(core, domains).voiceReplies, true);
  assert.deepEqual(domains.get("profile"), { model: "preferred/model", totalMessages: 1, totalCost: 0, voiceReplies: true, createdAt: original.createdAt });
});
