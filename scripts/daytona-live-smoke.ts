import { randomInt, randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore } from "../src/store.js";

/**
 * Explicit, destructive-safe integration probe for the real Daytona account.
 * It creates and removes only a random, memory-scoped test workspace.
 */
async function main(): Promise<void> {
  if (process.env.DAYTONA_LIVE_TEST !== "1") {
    throw new Error("Refusing live Daytona work. Re-run with DAYTONA_LIVE_TEST=1.");
  }
  if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is required for the live Daytona smoke test.");

  await initStore({ memoryOnly: true });
  const userId = 900_000_000 + randomInt(99_999_999);
  const probePath = `workspace/.chusky/live-probe-${randomUUID()}.txt`;
  const probeContent = "chusky live Daytona probe";
  const engine = new DaytonaEngine();
  let created = false;

  try {
    const workspace = await engine.workspace(userId, "create");
    created = true;
    await engine.writeFile(userId, probePath, probeContent);
    const read = await engine.readFile(userId, probePath, 200);
    const files = await engine.listFiles(userId, "workspace/.chusky", 2);
    if (read.content !== probeContent || !files.some((file) => file.path === probePath)) {
      throw new Error("Live Daytona create/write/read/list verification failed.");
    }
    const spreadsheet = await engine.createSpreadsheet(userId, {
      title: "Chusky Live QA Probe",
      path: `artifacts/live-qa-${randomUUID()}.xlsx`,
      sheets: [{ name: "Probe", rows: [["Check", "Result"], ["Daytona", "live"], ["Visual QA", "required"]] }],
    });
    if (!spreadsheet.generated || !spreadsheet.path.endsWith(".xlsx")) {
      throw new Error("Live Daytona spreadsheet generation or visual QA verification failed.");
    }
    console.log(JSON.stringify({ liveDaytona: "passed", workspaceState: "created", writeReadList: "passed", spreadsheetVisualQa: "passed", cleanup: "pending" }));
  } finally {
    if (created) await engine.workspace(userId, "delete");
  }

  console.log(JSON.stringify({ liveDaytona: "passed", cleanup: "deleted" }));
}

void main();
