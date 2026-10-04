import "dotenv/config";
import { Pool } from "pg";
import Redis from "ioredis";
import { config } from "../src/config.js";
import { durableImageObjectId, isAuthorizedDurableImage, registerDurableImageAsset } from "../src/durableImageCatalog.js";
import { validateImageCatalogBackfillCandidate } from "../src/durableImageCatalogBackfill.js";
import { createObjectMetadata, getDurableObjectMetadata, initStore, closeStore } from "../src/store.js";
import { inspectR2Object, readR2ObjectBounded, r2Configured } from "../src/lib/storage/r2.js";
import type { ImageAsset } from "../src/store.js";

const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes("--confirm-r2-image-catalog-backfill");
const maxOwnersArg = process.argv.find((arg) => arg.startsWith("--max-owners="))?.split("=", 2)[1];
const maxWritesArg = process.argv.find((arg) => arg.startsWith("--max-writes="))?.split("=", 2)[1];
const afterOwnerArg = process.argv.find((arg) => arg.startsWith("--after-user-id="))?.split("=", 2)[1];
const maxOwners = maxOwnersArg === undefined ? 200 : Number(maxOwnersArg);
const maxWrites = maxWritesArg === undefined ? 10 : Number(maxWritesArg);
const afterUserId = afterOwnerArg === undefined ? 0 : Number(afterOwnerArg);

if (apply && (!confirmed || maxOwnersArg === undefined || !Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 10
  || maxWritesArg === undefined || !Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 10)) {
  throw new Error("Apply requires confirmation, --max-owners=N (1..10), and --max-writes=N (1..10).");
}
if (!Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 1000) throw new Error("--max-owners must be an integer from 1 to 1000.");
if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 10) throw new Error("--max-writes must be an integer from 1 to 10.");
if (!Number.isSafeInteger(afterUserId) || afterUserId < 0) throw new Error("--after-user-id must be a non-negative integer.");
if (process.env.DURABLE_STATE_ENABLED !== "true") throw new Error("DURABLE_STATE_ENABLED=true is required.");
if (process.env.DURABLE_OBJECT_CATALOG_ENABLED !== "true") throw new Error("DURABLE_OBJECT_CATALOG_ENABLED=true is required.");
if (!config.redisUrl || !config.durableStateDatabaseUrl || !r2Configured()) throw new Error("Redis, the durable-state database, and R2 must be configured.");

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });
const database = new Pool({ connectionString: config.durableStateDatabaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
const sessionKeyPattern = /^chuck:session:(\d+)$/;

function parseImageAssets(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.imageAssets)) return undefined;
  return record.imageAssets;
}

async function readCanonicalImageAssets(userId: number): Promise<unknown[] | undefined> {
  const domain = await database.query<{ payload: unknown }>(
    "SELECT payload FROM chusky_session_domain WHERE user_id=$1 AND domain='assets'",
    [userId],
  );
  if (domain.rows[0]) return parseImageAssets(domain.rows[0].payload);

  const raw = await redis.get(`chuck:session:${userId}`);
  if (!raw) return [];
  let session: unknown;
  try { session = JSON.parse(raw); }
  catch { return undefined; }
  if (!session || typeof session !== "object" || Array.isArray(session)) return undefined;
  const record = session as Record<string, unknown>;
  // Once marked durable, a missing Neon assets domain is an inconsistency;
  // never fall back to a potentially stale Redis copy for backfill authority.
  if (record.durableSessionFormat === 1) return undefined;
  return parseImageAssets(record);
}

async function discoverOwners(): Promise<number[]> {
  const owners = new Set<number>();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "chuck:session:*", "COUNT", "200");
    cursor = next;
    for (const key of keys) {
      const match = sessionKeyPattern.exec(key);
      if (!match) continue;
      const userId = Number(match[1]);
      if (Number.isSafeInteger(userId) && userId > 0) owners.add(userId);
    }
  } while (cursor !== "0");

  // Include durable asset domains whose Redis hot-session key has expired.
  const durableOwners = await database.query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM chusky_session_domain WHERE domain='assets' AND user_id > 0 ORDER BY user_id",
  );
  for (const row of durableOwners.rows) {
    const userId = Number(row.user_id);
    if (Number.isSafeInteger(userId) && userId > 0) owners.add(userId);
  }
  return [...owners].filter((userId) => userId > afterUserId).sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const counts = {
    ownersScanned: 0,
    ownersWithAssets: 0,
    assetsScanned: 0,
    alreadyAuthorized: 0,
    eligible: 0,
    written: 0,
    rejected: 0,
    objectMismatch: 0,
    catalogConflict: 0,
    failed: 0,
  };
  let lastUserId = afterUserId;
  let writeLimitReached = false;
  let remainingOwners = 0;
  try {
    await initStore({ suppressStorageMetrics: true });
    const owners = await discoverOwners();
    const batch = owners.slice(0, maxOwners);
    remainingOwners = Math.max(0, owners.length - batch.length);
    for (const userId of batch) {
      lastUserId = userId;
      counts.ownersScanned += 1;
      let assets;
      try { assets = await readCanonicalImageAssets(userId); }
      catch { counts.failed += 1; continue; }
      if (!assets) { counts.failed += 1; continue; }
      if (assets.length) counts.ownersWithAssets += 1;
      for (const candidate of assets) {
        if (apply && counts.written >= maxWrites) {
          writeLimitReached = true;
          break;
        }
        counts.assetsScanned += 1;
        const rejection = validateImageCatalogBackfillCandidate(userId, candidate, config.sdkMaxFileBytes);
        if (rejection) { counts.rejected += 1; continue; }
        const asset = candidate as ImageAsset;

        const input = { userId, assetId: asset.id, r2Key: asset.r2Key, contentType: asset.contentType, size: asset.size };
        const objectId = durableImageObjectId(asset.id);
        let existing;
        try { existing = await getDurableObjectMetadata(userId, objectId); }
        catch { counts.failed += 1; continue; }
        if (existing) {
          if (isAuthorizedDurableImage(existing, input)) counts.alreadyAuthorized += 1;
          else counts.catalogConflict += 1;
          continue;
        }

        try {
          const remote = await inspectR2Object(asset.r2Key);
          if (remote.size !== asset.size || (remote.contentType && remote.contentType !== asset.contentType)) {
            counts.objectMismatch += 1;
            continue;
          }
          counts.eligible += 1;
          if (!apply) continue;

          // Re-read the owner's canonical session manifest immediately before
          // writing; a stale Redis scan alone is never sufficient authority.
          const latestAsset = (await readCanonicalImageAssets(userId))?.find((item) => {
            return validateImageCatalogBackfillCandidate(userId, item, config.sdkMaxFileBytes) === undefined
              && (item as ImageAsset).id === asset.id;
          }) as ImageAsset | undefined;
          if (!latestAsset || latestAsset.r2Key !== asset.r2Key || latestAsset.size !== asset.size
            || latestAsset.contentType !== asset.contentType || latestAsset.userId !== userId) {
            counts.rejected += 1;
            continue;
          }
          await registerDurableImageAsset(input, {
            inspect: inspectR2Object,
            readBounded: readR2ObjectBounded,
            create: createObjectMetadata,
            get: getDurableObjectMetadata,
            markDeleting: async () => false,
            markDeleted: async () => false,
            deleteObject: async () => { throw new Error("Backfill never deletes R2 objects"); },
          }, config.sdkMaxFileBytes);
          counts.written += 1;
        } catch {
          counts.failed += 1;
        }
      }
      if (writeLimitReached) break;
    }
    console.log(JSON.stringify({
      mode: apply ? "bounded_apply" : "dry_run",
      writesAreAdditiveMetadataOnly: true,
      deletesObjects: false,
      afterUserId,
      lastUserId,
      maxOwners,
      maxWrites: apply ? maxWrites : undefined,
      writeLimitReached,
      remainingOwners,
      ...counts,
    }));
    if (counts.failed || counts.catalogConflict || counts.objectMismatch || counts.rejected) process.exitCode = 2;
  } finally {
    await database.end();
    await redis.quit();
    await closeStore();
  }
}

void main().catch((error: unknown) => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  console.error(JSON.stringify({ mode: apply ? "bounded_apply" : "dry_run", failed: true, errorCode }));
  process.exitCode = 1;
});
