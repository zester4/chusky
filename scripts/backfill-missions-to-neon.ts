import { closeStore, getMission, listMissionEvents, listMissionOwnerIds, listMissions, migrateMissionOwnerToNeon, initStore } from "../src/store.js";
import { parseMissionBackfillCommand } from "../src/missionBackfillCommand.js";

const args = process.argv.slice(2);
const options = parseMissionBackfillCommand(args);
const { apply, userId } = options;

if (options.help) {
  console.log("Usage: npm run durable-missions:backfill [--user-id <numeric-owner>] [--apply --confirm-quiesced]");
  console.log("Default mode is read-only. Apply requires one explicit owner and all Chusky API, worker, and webhook processes to be stopped.");
  process.exit(0);
}
if (process.env.DURABLE_STATE_ENABLED !== "true" || process.env.DURABLE_STATE_MISSIONS_ENABLED !== "true") {
  throw new Error("Set DURABLE_STATE_ENABLED=true and DURABLE_STATE_MISSIONS_ENABLED=true after migrations 0009 and 0010 are applied.");
}

async function main(): Promise<void> {
  await initStore();
  try {
    const allOwners = await listMissionOwnerIds();
    const owners = userId === undefined ? allOwners : allOwners.filter((ownerId) => ownerId === userId);
    if (userId !== undefined && !owners.length) throw new Error("The selected owner has no indexed mission records.");

    if (!apply) {
      let missions = 0;
      let events = 0;
      for (const ownerId of owners) {
        const records = await listMissions(ownerId);
        missions += records.length;
        for (const mission of records) events += (await listMissionEvents(ownerId, mission.id, 5000)).length;
      }
      console.log(JSON.stringify({ mode: "dry_run", ownerCount: owners.length, missionCount: missions, eventCount: events, writes: 0 }));
      return;
    }

    let migratedOwners = 0;
    let alreadyMigratedOwners = 0;
    let missions = 0;
    let events = 0;
    for (const ownerId of owners) {
      const result = await migrateMissionOwnerToNeon(ownerId);
      if (result.status === "migrated") migratedOwners += 1;
      else alreadyMigratedOwners += 1;
      missions += result.missionCount;
      events += result.eventCount;
    }
    // Check owner-scoped read paths after cutover; do not print IDs or payloads.
    for (const ownerId of owners) {
      const records = await listMissions(ownerId);
      for (const mission of records) {
        const readBack = await getMission(ownerId, mission.id);
        if (!readBack || readBack.version !== mission.version) throw new Error("Post-cutover mission read-back verification failed.");
      }
    }
    console.log(JSON.stringify({ mode: "apply", ownerCount: owners.length, migratedOwners, alreadyMigratedOwners, missionCount: missions, eventCount: events, readBackVerified: true }));
  } finally {
    await closeStore();
  }
}

void main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "migration_failed";
  console.error(JSON.stringify({ failed: true, errorCode: code }));
  process.exitCode = 1;
});
