// Live verification runs only on a separately supplied Neon branch hostname.
const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
require('dotenv').config({ path: process.env.CHUSKY_ENV_FILE, quiet: true });
const source = new URL(process.env.DURABLE_STATE_DATABASE_URL);
const targetHost = process.env.NEON_VERIFY_HOST;
if (!targetHost || targetHost === source.hostname || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(targetHost)) {
  throw new Error('Supply a different Neon test-branch hostname in NEON_VERIFY_HOST.');
}
source.hostname = targetHost;
Object.assign(process.env, {
  NODE_ENV: 'development', DURABLE_STATE_ENABLED: 'true',
  DURABLE_STATE_DATABASE_URL: source.href, DURABLE_STATE_SDK_RUNS_ENABLED: 'true',
  DURABLE_STATE_SDK_TABLES_ENABLED: 'true', DURABLE_STORAGE_METRICS_ENABLED: 'false',
  DURABLE_MEMORY_ENABLED: 'false', DURABLE_OBJECT_CATALOG_ENABLED: 'false',
});
const { Pool } = require('pg');
const Redis = require('ioredis');
const { securePostgresConnectionString } = require('../dist/postgresConnection.js');
const { NeonDurableState, withNeonQueryMetricRoute } = require('../dist/neonDurableState.js');
const { splitSessionDomains } = require('../dist/sessionDomains.js');
const store = require('../dist/store.js');
const pool = new Pool({ connectionString: securePostgresConnectionString(source.href), max: 2, connectionTimeoutMillis: 10000 });
const state = new NeonDurableState(pool);
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
const owner = 8000000000000000 + randomInt(1000000);
const keys = ['session', 'session-domains', 'sdk-tables', 'sdk-threads', 'sdk-tables-ready'].map((name) => `chuck:${name}:${owner}`);
async function main() {
  await store.initStore({ suppressStorageMetrics: true });
  const now = Date.now();
  const session = await store.getSession(owner);
  const threadId = `thr_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  session.sdkThreads = [{ id: threadId, externalId: 'synthetic-verification', metadata: {},
    history: [{ role: 'user', content: 'legacy history' }],
    runs: [{ id: runId, status: 'completed', events: [], createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now }];
  session.sdkAudit = [{ id: `audit_${randomUUID()}`, action: 'verification', requestId: 'synthetic', status: 200, at: now }];
  session.sdkIdempotency = { legacy: { fingerprint: 'POST:/v1/reminders:{"text":"synthetic"}', response: { ok: true }, createdAt: now } };
  const legacy = splitSessionDomains(session, false, false);
  await state.writeSessionDomains(owner, legacy.domains);
  await redis.set(keys[0], JSON.stringify(legacy.core), 'EX', 600);
  await redis.del(...keys.slice(1));
  const coldReaders = await Promise.all(Array.from({ length: 4 }, () => store.listSdkThreads(owner)));
  for (const threads of coldReaders) assert.equal(threads[0].id, threadId);
  assert.equal((await store.listSdkRuns(owner, threadId))[0].id, runId);
  assert.equal((await store.getSdkThread(owner, threadId)).history[0].content, 'legacy history');
  assert.equal((await state.readSdkThreads(owner))[0].history.length, 0);
  assert.deepEqual(await store.getSdkRunUsage(owner), { count: 1, active: 0 });
  assert.equal((await store.getSdkIdempotency(owner, 'legacy')).response.ok, true);
  const before = await state.readSessionDomain(owner, 'sdk');
  assert.equal(Object.hasOwn(before.payload, 'sdkThreads'), false);
  await store.appendSdkAuditEvent(owner, { id: `audit_${randomUUID()}`, action: 'verification-direct', requestId: 'synthetic', status: 200, at: now + 1 });
  assert.equal((await state.readSessionDomain(owner, 'sdk')).version, before.version);
  assert.equal((await store.listSdkAuditEvents(owner)).length, 2);
  assert.equal(await state.readSdkThread(owner + 1, threadId), undefined);
  await withNeonQueryMetricRoute('GET /v1/threads/:threadId', () => state.readSdkThread(owner, threadId));
  await state.flushQueryMetrics();
  const totals = await state.queryMetricTotals(now - 1000);
  assert.ok(totals['postgres.query.samples.1d'] > 0);
  assert.ok(Object.keys(totals).some((key) => key.startsWith('postgres.query.route.route_GET_v1_threads')));
  console.log(JSON.stringify({ passed: true, legacyThreadsAndRunsPreserved: true, historyPreserved: true,
    directAuditAvoidsDomainWrite: true, ownerIsolation: true, realQueryMetricsPersisted: true }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  // Only keys belonging to this random synthetic test owner are removed.
  await redis.del(...keys);
  await redis.quit();
  await store.closeStore();
  await pool.end();
});
