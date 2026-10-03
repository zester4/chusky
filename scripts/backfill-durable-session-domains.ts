import { resolve } from "node:path";
import dotenv from "dotenv";
import Redis from "ioredis";
import { DURABLE_SESSION_FORMAT, sessionUsesNeonDomains } from "../src/sessionDomains.js";
import type { UserSession } from "../src/store.js";

dotenv.config({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });

if (process.argv.includes("--apply")) {
  throw new Error("Bulk apply is disabled: cross-store session writes need a coordinated concurrency protocol before this migration can safely run.");
}
if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for a session-domain migration dry run.");

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });
const keyPattern = /^chuck:session:(\d+)$/;

async function main(): Promise<void> {
  const counts = { scanned: 0, legacyCandidates: 0, alreadyMigrated: 0, skipped: 0, invalid: 0 };
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "chuck:session:*", "COUNT", "100");
      cursor = next;
      for (const key of keys) {
        counts.scanned += 1;
        if (!keyPattern.test(key)) { counts.skipped += 1; continue; }
        const raw = await redis.get(key);
        if (!raw) { counts.skipped += 1; continue; }
        let session: unknown;
        try { session = JSON.parse(raw); }
        catch { counts.invalid += 1; continue; }
        if (!session || typeof session !== "object" || Array.isArray(session)) { counts.invalid += 1; continue; }
        if (sessionUsesNeonDomains(session as UserSession)) counts.alreadyMigrated += 1;
        else counts.legacyCandidates += 1;
      }
    } while (cursor !== "0");
    console.log(JSON.stringify({ mode: "dry_run_only", durableSessionFormat: DURABLE_SESSION_FORMAT, ...counts }));
    if (counts.invalid) process.exitCode = 2;
  } finally {
    await redis.quit();
  }
}

void main().catch((error: unknown) => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  console.error(JSON.stringify({ mode: "dry_run_only", failed: true, errorCode }));
  process.exitCode = 1;
});
