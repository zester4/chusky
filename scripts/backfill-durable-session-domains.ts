import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import Redis from "ioredis";
import { withDistributedLease } from "../src/distributedLease.js";
import { DURABLE_SESSION_FORMAT, sessionUsesNeonDomains } from "../src/sessionDomains.js";
import { backfillDurableSessionSnapshot } from "../src/durableSessionBackfill.js";
import { createNeonDurableState } from "../src/neonDurableState.js";
import type { UserSession } from "../src/store.js";

dotenv.config({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for a session-domain migration dry run.");

const apply = process.argv.includes("--apply");
const maxSessionsArg = process.argv.find((arg) => arg.startsWith("--max-sessions="))?.split("=", 2)[1];
const maxSessions = maxSessionsArg === undefined ? undefined : Number(maxSessionsArg);
if (apply && (!Number.isSafeInteger(maxSessions) || maxSessions! < 1 || maxSessions! > 100)) {
  throw new Error("Apply requires --max-sessions=N with an integer from 1 to 100.");
}
if (!apply && maxSessionsArg !== undefined) throw new Error("--max-sessions is available only with --apply.");
const databaseUrl = process.env.DURABLE_STATE_DATABASE_URL?.trim();
if (apply && !databaseUrl) throw new Error("DURABLE_STATE_DATABASE_URL is required for session-domain apply.");

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });
const keyPattern = /^chuck:session:(\d+)$/;
const compareAndSetScript = `local current=redis.call('get',KEYS[1]); if current ~= ARGV[1] then return 0 end; local ttl=redis.call('pttl',KEYS[1]); if ttl == -2 then return 0 end; if ttl == -1 then redis.call('set',KEYS[1],ARGV[2]) else if ttl <= 0 then return 0 end; redis.call('set',KEYS[1],ARGV[2],'PX',ttl) end; return 1`;
const renewLeaseScript = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
const releaseLeaseScript = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

async function withSessionMigrationLease<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const key = `chuck:key-lock:session-domain:${userId}`;
  const token = randomUUID();
  return withDistributedLease({
    acquire: async () => await redis.set(key, token, "PX", 30_000, "NX") === "OK",
    renew: async () => Number(await redis.eval(renewLeaseScript, 1, key, token, 30_000)) === 1,
    release: async () => { await redis.eval(releaseLeaseScript, 1, key, token); },
  }, work, {
    busyMessage: "Owner session is busy; retry the bounded migration later.",
    lostMessage: "Session migration lost its coordination lease; inspect the owner before retrying.",
  });
}

async function main(): Promise<void> {
  const counts = { scanned: 0, legacyCandidates: 0, alreadyMigrated: 0, migrated: 0, changedDuringMigration: 0, neonConflict: 0, skipped: 0, invalid: 0 };
  let durableState: Awaited<ReturnType<typeof createNeonDurableState>>;
  try {
    durableState = apply ? await createNeonDurableState(databaseUrl!) : undefined;
    if (apply && !durableState) throw new Error("Neon durable session store could not be initialized.");
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "chuck:session:*", "COUNT", "100");
      cursor = next;
      for (const key of keys) {
        counts.scanned += 1;
        if (!keyPattern.test(key)) { counts.skipped += 1; continue; }
        if (durableState && counts.migrated + counts.changedDuringMigration + counts.neonConflict >= maxSessions!) break;
        const userId = Number(key.match(keyPattern)![1]);
        const inspectAndMigrate = async () => {
          // In apply mode the owner lease is acquired before reading Redis, so
          // the snapshot cannot go stale while Neon domains are being written.
          const raw = await redis.get(key);
          if (!raw) { counts.skipped += 1; return; }
          let session: unknown;
          try { session = JSON.parse(raw); }
          catch { counts.invalid += 1; return; }
          if (!session || typeof session !== "object" || Array.isArray(session)) { counts.invalid += 1; return; }
          if (sessionUsesNeonDomains(session as UserSession)) { counts.alreadyMigrated += 1; return; }
          if (!durableState) { counts.legacyCandidates += 1; return; }

          counts.legacyCandidates += 1;
          const result = await backfillDurableSessionSnapshot(userId, raw, {
            state: durableState,
            compareAndSetRedisSession: async (ownerId, expectedRaw, replacement) => Number(await redis.eval(compareAndSetScript, 1, `chuck:session:${ownerId}`, expectedRaw, replacement)) === 1,
          });
          if (result === "migrated") counts.migrated += 1;
          else if (result === "already_migrated") counts.alreadyMigrated += 1;
          else if (result === "redis_changed") counts.changedDuringMigration += 1;
          else counts.neonConflict += 1;
        };
        if (durableState) await withSessionMigrationLease(userId, inspectAndMigrate);
        else await inspectAndMigrate();
      }
      if (durableState && counts.migrated + counts.changedDuringMigration + counts.neonConflict >= maxSessions!) break;
    } while (cursor !== "0");
    console.log(JSON.stringify({ mode: apply ? "bounded_apply" : "dry_run_only", durableSessionFormat: DURABLE_SESSION_FORMAT, ...(apply ? { maxSessions } : {}), ...counts }));
    if (counts.invalid) process.exitCode = 2;
  } finally {
    await redis.quit();
    await durableState?.close();
  }
}

void main().catch((error: unknown) => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  console.error(JSON.stringify({ mode: apply ? "bounded_apply" : "dry_run_only", failed: true, errorCode }));
  process.exitCode = 1;
});
