import { migrateAuthDatabase } from "./auth.js";

migrateAuthDatabase()
  .then(() => { console.log("Better Auth migrations completed."); })
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
