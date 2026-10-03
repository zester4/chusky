import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import dotenv from "dotenv";
import Redis from "ioredis";
import { Pool } from "pg";

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

const expectedDomains = ["assets", "conversation", "memories", "sdk"];
const userId = 8_000_000_000_000_000 + randomInt(0, 1_000_000);
const marker = `durable-state-smoke-${randomInt(1_000_000, 9_999_999)}`;
const threadId = `thr_smoke_${randomInt(1_000_000, 9_999_999)}`;
const runId = `run_smoke_${randomInt(1_000_000, 9_999_999)}`;
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });

async function main(): Promise<void> {
  let runError: unknown;
  try {
    const store = await import("../src/store.js");
    await store.initStore();
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
    await store.saveSession(userId, session);

    const restored = await store.getSessionWithSdkRuns(userId, threadId);
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
    const presentDomains = result.rows.map((row) => row.domain);
    const restoredRun = restored.sdkThreads?.find((thread) => thread.id === threadId)?.runs.find((run) => run.id === runId);
    if (restored.history?.[0]?.content !== marker || restoredRun?.output !== marker
      || expectedDomains.some((domain) => !presentDomains.includes(domain))
      || runRows.rows[0]?.records !== 1 || sdkDomain.rows[0]?.embedded_runs !== 0) {
      throw new Error("Chusky session domains or per-run SDK storage did not round-trip through Neon.");
    }

    console.log(JSON.stringify({
      chuskyStoreWrite: true,
      sessionReadBack: true,
      domains: result.rows.map(({ domain, records }) => ({ domain, records })),
      sdkRunRows: runRows.rows[0]?.records ?? 0,
      embeddedSdkRuns: sdkDomain.rows[0]?.embedded_runs ?? 0,
      payloadInspected: false,
    }));
  } catch (error) {
    runError = error;
  } finally {
    // The smoke uses a synthetic, high-range owner ID and removes only its own
    // test rows and Redis session, including after a partially successful write.
    const cleanup = await Promise.allSettled([
      pool.query("DELETE FROM public.chusky_session_domain WHERE user_id = $1", [userId]),
      pool.query("DELETE FROM public.chusky_sdk_run WHERE user_id = $1", [userId]),
      redis.del(`chuck:session:${userId}`),
    ]);
    const leftovers = await pool.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM public.chusky_session_domain WHERE user_id = $1) OR EXISTS (SELECT 1 FROM public.chusky_sdk_run WHERE user_id = $1) AS present",
      [userId],
    ).catch((error: unknown) => { throw error; });
    await Promise.allSettled([pool.end(), redis.quit()]);
    if (cleanup.some((result) => result.status === "rejected") || leftovers.rows[0]?.present) {
      throw new Error("The live smoke could not confirm cleanup of its isolated test records.");
    }
    console.log(JSON.stringify({ isolatedTestDataCleaned: true, redisSessionKeyRemoved: cleanup[2]?.status === "fulfilled" && cleanup[2].value === 1 }));
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
