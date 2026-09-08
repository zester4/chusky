/** Render real retained smoke-test artifacts in the production renderer snapshot. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDaytonaClient } from "../src/lib/daytona/client.js";
import { artifactVisualQaScript } from "../src/lib/daytona/artifactQa.js";

const remoteBase = process.argv[2];
if (!remoteBase) throw new Error("Pass the workspace-relative smoke-test directory");
const snapshot = process.env.DAYTONA_RENDERER_SNAPSHOT;
if (!snapshot) throw new Error("DAYTONA_RENDERER_SNAPSHOT is required for live renderer QA");

async function main(): Promise<void> {
  const localDirectory = join(process.cwd(), remoteBase);
  let renderer: Awaited<ReturnType<ReturnType<typeof getDaytonaClient>["create"]>> | undefined;
  const results: Array<{ name: string; type: string; exitCode: number; output: string }> = [];
  try {
    renderer = await getDaytonaClient().create({
      name: `chusky-renderer-qa-${Date.now()}`,
      snapshot,
      networkBlockAll: true,
      public: false,
      autoStopInterval: 10,
      autoDeleteInterval: 0,
      ttlMinutes: 30,
      labels: { agent: "chusky", purpose: "renderer-live-qa" },
    }, { timeout: 120 });
    for (const [name, type] of [["live-branded.pdf", "pdf"], ["live-branded.docx", "docx"], ["live-branded.pptx", "presentation"], ["live-branded.xlsx", "spreadsheet"]] as const) {
      const bytes = await readFile(join(localDirectory, name));
      if (!bytes.length) throw new Error(`${name} is empty`);
      const rendererPath = `qa-${name}`;
      await renderer.fs.uploadFile(bytes, rendererPath);
      const encoded = Buffer.from(artifactVisualQaScript(type, rendererPath), "utf8").toString("base64");
      const result = await renderer.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, await renderer.getUserHomeDir(), undefined, 180);
      const output = String(result.result ?? "").slice(0, 2000);
      results.push({ name, type, exitCode: result.exitCode ?? 1, output });
      if (result.exitCode !== 0) throw new Error(`${name} renderer QA failed: ${output}`);
    }
  } finally {
    if (renderer) await renderer.delete();
  }
  await writeFile(join(localDirectory, "renderer-qa.json"), `${JSON.stringify({ snapshot, remoteBase, results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ remoteBase, results }, null, 2)}\n`);
}

main().then(() => process.exit(0)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });
