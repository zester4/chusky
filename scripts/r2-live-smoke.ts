import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run r2:live-smoke -- --apply --confirm-synthetic-r2-canary");
  console.log("Uploads and deletes one generated synthetic object and owner-scoped Neon metadata row.");
  process.exit(0);
}
if (!args.includes("--apply") || !args.includes("--confirm-synthetic-r2-canary") || args.length !== 2) {
  throw new Error("R2 canary requires both --apply and --confirm-synthetic-r2-canary; no object was written.");
}
if (process.env.DURABLE_STATE_ENABLED !== "true" || process.env.DURABLE_OBJECT_CATALOG_ENABLED !== "true") {
  throw new Error("Enable DURABLE_STATE_ENABLED and DURABLE_OBJECT_CATALOG_ENABLED after applying migration 0008.");
}
if (!process.env.REDIS_URL || !(process.env.DURABLE_STATE_DATABASE_URL || process.env.BETTER_AUTH_DATABASE_URL)) {
  throw new Error("Configured Redis and durable-state Neon URLs are required; no object was written.");
}

let stage = "load-config";
const stageHistory: string[] = [];

function setStage(next: string): void {
  stage = next;
  stageHistory.push(next);
  if (stageHistory.length > 12) stageHistory.shift();
}

async function main(): Promise<void> {
  const [{ config }, store, r2, { runSyntheticR2Canary }] = await Promise.all([
    import("../src/config.js"),
    import("../src/store.js"),
    import("../src/lib/storage/r2.js"),
    import("../src/r2Canary.js"),
  ]);
  if (config.durableStateEnabled !== true || config.durableObjectCatalogEnabled !== true) {
    throw new Error("Durable Neon state and the object catalog must both be enabled; no object was written.");
  }
  if (!r2.r2Configured()) throw new Error("R2 credentials and bucket configuration are required; no object was written.");
  try {
    setStage("initialize-store");
    await store.initStore();
    const observed = <Args extends unknown[], Result>(name: string, operation: (...args: Args) => Promise<Result>) =>
      (...args: Args): Promise<Result> => { setStage(name); return operation(...args); };
    let metadataReads = 0;
    setStage("prepare-canary");
    const result = await runSyntheticR2Canary({
      createMetadata: observed("neon-create-pending", store.createDurableObjectMetadata),
      putObject: observed("r2-put", r2.putR2Object),
      inspectObject: observed("r2-head", r2.inspectR2Object),
      readObjectBounded: observed("r2-read-back", r2.readR2ObjectBounded),
      markAvailable: observed("neon-mark-available", store.markDurableObjectAvailable),
      getMetadata: (...args) => {
        metadataReads += 1;
        const name = metadataReads === 1 ? "neon-owner-record-readback"
          : metadataReads === 2 ? "neon-other-owner-denial" : "neon-cleanup-readback";
        return observed(name, store.getDurableObjectMetadata)(...args);
      },
      markDeleting: observed("neon-tombstone-cleanup", store.markDurableObjectDeleting),
      deleteObject: observed("r2-delete-cleanup", r2.deleteR2Object),
      markDeleted: observed("neon-confirm-cleanup", store.markDurableObjectDeleted),
    });
    console.log(JSON.stringify({ mode: "synthetic_live_canary", ...result, payloadLogged: false, ownerIdLogged: false, objectKeyLogged: false }));
  } finally {
    await store.closeStore();
  }
}

void main().catch((error: unknown) => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "r2_live_smoke_failed";
  console.error(JSON.stringify({ failed: true, stage, recentStages: stageHistory, errorCode }));
  process.exitCode = 1;
});
