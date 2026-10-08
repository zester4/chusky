import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import dotenv from "dotenv";
import Redis from "ioredis";
import { Pool } from "pg";
import { securePostgresConnectionString } from "../src/postgresConnection.js";
import { reserveDurableSmokeScope } from "../src/durableSmokeGuard.js";

dotenv.config({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });

const databaseUrl = process.env.DURABLE_STATE_DATABASE_URL ?? process.env.BETTER_AUTH_DATABASE_URL;
if (!databaseUrl || !process.env.REDIS_URL) {
  throw new Error("DURABLE_STATE_DATABASE_URL (or BETTER_AUTH_DATABASE_URL) and REDIS_URL are required.");
}

// Configure before importing store/config so this exercises Chusky's normal
// Redis session core plus the real Neon durable-domain repository.
process.env.DURABLE_STATE_ENABLED = "true";
process.env.DURABLE_STATE_DATABASE_URL = databaseUrl;
process.env.DURABLE_STATE_SDK_RUNS_ENABLED = "true";

const expectedDomains = ["assets", "conversation", "memories", "profile", "sdk"];
const userId = 8_000_000_000_000_000 + randomInt(0, 1_000_000);
const marker = `durable-state-smoke-${randomInt(1_000_000, 9_999_999)}`;
const threadId = `thr_smoke_${randomInt(1_000_000, 9_999_999)}`;
const runId = `run_smoke_${randomInt(1_000_000, 9_999_999)}`;
const sessionKey = `chuck:session:${userId}`;
const domainsKey = `chuck:session-domains:${userId}`;
const reservationKey = `chuck:durable-state-live-smoke:${userId}`;
const reservationToken = randomUUID();
const pool = new Pool({ connectionString: securePostgresConnectionString(databaseUrl), max: 1, connectionTimeoutMillis: 10_000 });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });

async function main(): Promise<void> {
  let runError: unknown;
  let stage = "initialize-store";
  let releaseSmokeScope: (() => Promise<void>) | undefined;
  try {
    stage = "reserve-synthetic-scope";
    releaseSmokeScope = await reserveDurableSmokeScope(userId, reservationToken, {
      async hasNeonRows(ownerId) {
        const result = await pool.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM public.chusky_session_domain WHERE user_id = $1) OR EXISTS (SELECT 1 FROM public.chusky_sdk_run WHERE user_id = $1) OR EXISTS (SELECT 1 FROM public.chusky_conversation_message WHERE user_id = $1) AS present",
          [ownerId],
        );
        return result.rows[0]?.present === true;
      },
      async hasRedisSessionKeys() {
        return (await redis.exists(sessionKey, domainsKey)) > 0;
      },
      async acquireReservation(_ownerId, token) {
        return await redis.set(reservationKey, token, "EX", 600, "NX") === "OK";
      },
      async releaseReservation(_ownerId, token) {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          reservationKey,
          token,
        );
      },
    });

    stage = "initialize-store";
    const store = await import("../src/store.js");
    await store.initStore();
    stage = "load-session";
    const session = await store.getSession(userId);
    session.history = [{ role: "user", content: marker }];
    session.totalMessages = 1;
    session.sdkThreads = [{
      id: threadId,
      externalId: marker,
      metadata: { source: "durable-state-live-smoke" },
      history: [],
      runs: [{ id: runId, status: "completed", input: marker, output: marker, events: [], createdAt: Date.now(), updatedAt: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
    stage = "save-session";
    await store.saveSession(userId, session);
    // Request handlers can persist one in-memory session repeatedly. A no-op
    // second save must not conflict or bump durable row versions.
    await store.saveSession(userId, session);

    stage = "read-session-and-sdk-runs";
    const restored = await store.getSessionWithSdkRuns(userId, threadId);
    stage = "inspect-neon-row-counts";
    const result = await pool.query<{ domain: string; records: number }>(
      "SELECT domain, COUNT(*)::int AS records FROM public.chusky_session_domain WHERE user_id = $1 GROUP BY domain ORDER BY domain",
      [userId],
    );
    const runRows = await pool.query<{ records: number }>(
      "SELECT COUNT(*)::int AS records FROM public.chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 AND run_id = $3",
      [userId, threadId, runId],
    );
    const sdkDomain = await pool.query<{ embedded_runs: number }>(
      "SELECT COALESCE(SUM(jsonb_array_length(thread.value->'runs')), 0)::int AS embedded_runs FROM public.chusky_session_domain CROSS JOIN LATERAL jsonb_array_elements(payload->'sdkThreads') AS thread(value) WHERE user_id = $1 AND domain = 'sdk'",
      [userId],
    );
    const messageRows = await pool.query<{ records: number }>(
      "SELECT COUNT(*)::int AS records FROM public.chusky_conversation_message WHERE user_id = $1",
      [userId],
    );
    const domainVersions = await pool.query<{ total: number }>(
      "SELECT COALESCE(SUM(version), 0)::int AS total FROM public.chusky_session_domain WHERE user_id = $1",
      [userId],
    );
    const runVersion = await pool.query<{ version: number }>(
      "SELECT version::int AS version FROM public.chusky_sdk_run WHERE user_id = $1 AND thread_id = $2 AND run_id = $3",
      [userId, threadId, runId],
    );
    const presentDomains = result.rows.map((row) => row.domain);
    const restoredRun = restored.sdkThreads?.find((thread) => thread.id === threadId)?.runs.find((run) => run.id === runId);
    const smokeChecks = {
      historyRoundTrip: restored.history?.[0]?.content === marker,
      sdkRunRoundTrip: restoredRun?.output === marker,
      allDomainsPresent: expectedDomains.every((domain) => presentDomains.includes(domain)),
      oneRunRow: runRows.rows[0]?.records === 1,
      noEmbeddedRuns: sdkDomain.rows[0]?.embedded_runs === 0,
      oneMessageRow: messageRows.rows[0]?.records === 1,
      unchangedDomainVersions: domainVersions.rows[0]?.total === 5,
      unchangedSdkRunVersion: runVersion.rows[0]?.version === 1,
    };
    if (Object.values(smokeChecks).some((passed) => !passed)) {
      console.error(JSON.stringify({ liveSmokeChecks: smokeChecks, domainVersionTotal: domainVersions.rows[0]?.total, sdkRunVersion: runVersion.rows[0]?.version }));
      throw new Error("Chusky session domains or per-run SDK storage did not round-trip through Neon.");
    }

    // Simulate expiration of both Redis session and domain cache. Recovery must
    // use Neon's durable profile/domains and recent message table, not return a
    // blank session or depend on cache payloads.
    stage = "expire-redis-cache-and-recover-from-neon";
    const expiredKeys = await redis.del(`chuck:session:${userId}`, `chuck:session-domains:${userId}`);
    const recovered = await store.getSession(userId);
    stage = "read-sdk-run-after-cache-expiry";
    const recoveredWithRuns = await store.getSessionWithSdkRuns(userId, threadId);
    const recoveredThread = recovered.sdkThreads?.find((thread) => thread.id === threadId);
    const recoveredRun = recoveredWithRuns.sdkThreads?.find((thread) => thread.id === threadId)?.runs.find((run) => run.id === runId);
    if (recovered.history?.[0]?.content !== marker || recovered.model !== session.model
      || !recoveredThread || recoveredThread.runs.length !== 0 || recoveredRun?.output !== marker) {
      throw new Error("Expired Redis session did not recover its recent context and profile from Neon.");
    }

    console.log(JSON.stringify({
      chuskyStoreWrite: true,
      sessionReadBack: true,
      expiredRedisCacheRecoveredFromNeon: true,
      domains: result.rows.map(({ domain, records }) => ({ domain, records })),
      sdkRunRows: runRows.rows[0]?.records ?? 0,
      conversationRows: messageRows.rows[0]?.records ?? 0,
      unchangedRepeatSaveKeptDomainAndRunVersions: domainVersions.rows[0]?.total === 5 && runVersion.rows[0]?.version === 1,
      embeddedSdkRuns: sdkDomain.rows[0]?.embedded_runs ?? 0,
      redisKeysExpiredForRecoveryTest: expiredKeys,
      payloadInspected: false,
    }));
  } catch (error) {
    runError = error;
    console.error(JSON.stringify({ liveSmokeFailureStage: stage }));
  } finally {
    // Only delete rows after the unused synthetic owner scope was checked and
    // reserved. A collision or failed reservation must never enter cleanup.
    const cleanup = releaseSmokeScope ? await Promise.allSettled([
      pool.query("DELETE FROM public.chusky_session_domain WHERE user_id = $1", [userId]),
      pool.query("DELETE FROM public.chusky_sdk_run WHERE user_id = $1", [userId]),
      pool.query("DELETE FROM public.chusky_conversation_message WHERE user_id = $1", [userId]),
      redis.del(sessionKey, domainsKey),
    ]) : [];
    const reservationRelease = releaseSmokeScope
      ? await Promise.allSettled([releaseSmokeScope()])
      : [];
    const leftovers = releaseSmokeScope ? await pool.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM public.chusky_session_domain WHERE user_id = $1) OR EXISTS (SELECT 1 FROM public.chusky_sdk_run WHERE user_id = $1) OR EXISTS (SELECT 1 FROM public.chusky_conversation_message WHERE user_id = $1) AS present",
      [userId],
    ) : undefined;
    await Promise.allSettled([pool.end(), redis.quit()]);
    if (releaseSmokeScope && (cleanup.some((result) => result.status === "rejected")
      || reservationRelease.some((result) => result.status === "rejected")
      || leftovers?.rows[0]?.present)) {
      throw new Error("The live smoke could not confirm cleanup of its isolated test records.");
    }
    console.log(JSON.stringify(releaseSmokeScope
      ? { isolatedTestDataCleaned: true, redisSessionKeysRemoved: cleanup[3]?.status === "fulfilled" ? cleanup[3].value : 0 }
      : { syntheticScopeCleanupSkipped: true }));
  }
  if (runError) throw runError;
}

void main().catch((error: unknown) => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  console.error(JSON.stringify({ chuskyStoreWrite: false, errorCode }));
  process.exitCode = 1;
}).finally(() => {
  // initStore owns long-lived pools for the service; this CLI smoke is a
  // one-shot process, so exit after its separately owned cleanup completes.
  setTimeout(() => process.exit(process.exitCode ?? 0), 0);
});
