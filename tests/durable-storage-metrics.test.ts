import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NeonDurableState, type StorageMetricSample } from "../src/neonDurableState.js";
import { RedisCommandMetrics } from "../src/redisMetrics.js";
import { RedisMetricsPublisher } from "../src/redisMetricsPublisher.js";

class MetricClient {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  returnedRows: Array<Record<string, unknown>> = [];
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    return { rows: this.returnedRows as never[] };
  }
  release() { /* fake */ }
}

class MetricPool {
  readonly client = new MetricClient();
  async query(text: string, values?: unknown[]) { return this.client.query(text, values); }
  async connect() { return this.client; }
  async end() { /* fake */ }
}

const sample: StorageMetricSample = {
  family: "session",
  commands: 18,
  errors: 1,
  requestBytes: 2048,
  responseBytes: 4096,
  durationMs: 512,
  maxValueBytes: 1024,
};

test("durable storage metric batches validate identity and transactionally upsert safe family aggregates", async () => {
  const pool = new MetricPool();
  const state = new NeonDurableState(pool as never);
  await state.recordStorageMetricBatch("11111111-1111-4111-8111-111111111111", 1, 1_800_000_000_000, [sample]);

  assert.equal(pool.client.calls[0]?.text, "BEGIN");
  assert.equal(pool.client.calls.at(-1)?.text, "COMMIT");
  const insert = pool.client.calls[1]!;
  assert.match(insert.text, /INSERT INTO chusky_storage_metric_sample/);
  assert.match(insert.text, /ON CONFLICT \(instance_id, batch_id, family\) DO NOTHING/);
  assert.deepEqual(insert.values, ["11111111-1111-4111-8111-111111111111", 1, 1_800_000_000_000, ["session"], [18], [1], [2048], [4096], [512], [1024]]);
  await assert.rejects(() => state.recordStorageMetricBatch("not-a-uuid", 1, 1_800_000_000_000, [sample]), /instance/);
  await assert.rejects(() => state.recordStorageMetricBatch("11111111-1111-4111-8111-111111111111", 0, 1_800_000_000_000, [sample]), /batch/);
  await assert.rejects(() => state.recordStorageMetricBatch("11111111-1111-4111-8111-111111111111", 2, 1_800_000_000_000, [{ ...sample, family: "secret:key" } as never]), /family/);
});

test("durable Redis metric totals use a bounded retention window and sanitize aggregate values", async () => {
  const pool = new MetricPool();
  pool.client.returnedRows = [{ family: "session", commands: "18", errors: "1", request_bytes: "2048", response_bytes: "4096", duration_ms: "512", max_value_bytes: "1024" }];
  const state = new NeonDurableState(pool as never);
  const totals = await state.storageMetricTotals(1_800_000_000_000, 30);
  assert.deepEqual(pool.client.calls[0]?.values, [1_800_000_000_000, 30]);
  assert.match(pool.client.calls[0]?.text ?? "", /observed_at >= GREATEST\(to_timestamp\(\$1 \/ 1000\.0\), now\(\) - \(\$2::integer \* interval '1 day'\)\)/);
  assert.match(pool.client.calls[0]?.text ?? "", /GROUP BY family/);
  const { family: _family, ...expectedTotals } = sample;
  assert.deepEqual(totals.session, expectedTotals);
  assert.equal(totals.other.commands, 0);
  assert.equal(JSON.stringify(totals).includes("user_id"), false);
  await assert.rejects(() => state.storageMetricTotals(1_800_000_000_000, 31), /window/);
});

test("metric retention deletes only a bounded expired batch", async () => {
  const pool = new MetricPool();
  pool.client.returnedRows = Array.from({ length: 2 }, () => ({ family: "session" }));
  const state = new NeonDurableState(pool as never);
  assert.equal(await state.pruneStorageMetrics(1_800_000_000_000, 5000), 2);
  assert.match(pool.client.calls[0]?.text ?? "", /WITH expired AS/);
  assert.match(pool.client.calls[0]?.text ?? "", /ORDER BY observed_at LIMIT \$2/);
  assert.deepEqual(pool.client.calls[0]?.values, [1_800_000_000_000, 5000]);
  await assert.rejects(() => state.pruneStorageMetrics(1_800_000_000_000, 5001), /limit/);
});

test("Redis metrics publisher retries the identical batch id after an ambiguous persistence failure", async () => {
  const metrics = new RedisCommandMetrics();
  metrics.record({ name: "set", args: ["chuck:session:1", "payload"] }, { result: "OK", durationMs: 3 });
  const attempts: Array<{ batchId: number; samples: readonly StorageMetricSample[] }> = [];
  let failFirst = true;
  const publisher = new RedisMetricsPublisher(metrics, async (_instanceId, batchId, _observedAt, samples) => {
    attempts.push({ batchId, samples: samples.map((item) => ({ ...item })) });
    if (failFirst) { failFirst = false; throw new Error("database acknowledgement lost"); }
  }, { instanceId: "11111111-1111-4111-8111-111111111111", now: () => 1_800_000_000_000 });

  assert.equal(await publisher.flush(), false);
  metrics.record({ name: "get", args: ["chuck:session:1"] }, { result: "new", durationMs: 2 });
  assert.equal(await publisher.flush(), true);
  assert.equal(attempts[0]?.batchId, attempts[1]?.batchId);
  assert.equal(attempts[1]?.samples[0]?.commands, 1);
  assert.notEqual(attempts[2]?.batchId, attempts[1]?.batchId);
  assert.equal(attempts[2]?.samples[0]?.commands, 1);
  assert.equal(metrics.snapshot().session.commands, 0);
});

test("storage metric persistence migration is append-only and indexable by retention time", async () => {
  const sql = await readFile(path.join(process.cwd(), "migrations", "0011_storage_metric_samples.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chusky_storage_metric_sample/);
  assert.match(sql, /PRIMARY KEY \(instance_id, batch_id, family\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS chusky_storage_metric_sample_observed_at_idx/);
  assert.match(sql, /CHECK \(family IN/);
});
