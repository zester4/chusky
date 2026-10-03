import { config } from "../src/config.js";
import { closeStore, initStore, runR2RetentionSweep } from "../src/store.js";
import { r2Configured } from "../src/lib/storage/r2.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirmed = args.includes("--confirm-expired-objects");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 100;

if (args.includes("--help")) {
  console.log("Usage: npm run r2:retention [--limit 1..500] [--apply --confirm-expired-objects]");
  console.log("Default mode is read-only. Apply deletes only objects whose Neon retention deadline has passed.");
  process.exit(0);
}
if (apply !== confirmed) throw new Error("R2 deletion requires both --apply and --confirm-expired-objects; omit both for a dry run.");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (limitIndex >= 0 && !args[limitIndex + 1])) {
  throw new Error("--limit must be an integer from 1 to 500.");
}
if (config.durableStateEnabled !== true || config.durableObjectCatalogEnabled !== true) {
  throw new Error("Enable DURABLE_STATE_ENABLED and DURABLE_OBJECT_CATALOG_ENABLED after applying migration 0008.");
}
if (apply && !r2Configured()) throw new Error("R2 credentials and bucket configuration are required to apply retention deletes.");

async function main(): Promise<void> {
  await initStore();
  try {
    const result = await runR2RetentionSweep({ limit, apply });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", ...result }));
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await closeStore();
  }
}

void main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "retention_sweep_failed";
  console.error(JSON.stringify({ failed: true, errorCode: code }));
  process.exitCode = 1;
});
