import { randomInt, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
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
    const probes: Array<{ type: "pdf" | "docx" | "presentation" | "spreadsheet"; extension: "pdf" | "docx" | "pptx" | "xlsx"; artifact: any; signature: (data: Buffer) => boolean }> = [
      {
        type: "pdf",
        extension: "pdf",
        artifact: await engine.createPdf(userId, {
          title: "Chusky Live QA Probe",
          path: `artifacts/live-qa-${randomUUID()}.pdf`,
          sections: [{ heading: "Verification", body: "Live artifact lifecycle probe." }],
        }),
        signature: (data) => data.subarray(0, 5).toString("ascii") === "%PDF-",
      },
      {
        type: "docx",
        extension: "docx",
        artifact: await engine.createDocument(userId, {
          title: "Chusky Live QA Probe",
          path: `artifacts/live-qa-${randomUUID()}.docx`,
          sections: [{ heading: "Verification", body: "Live artifact lifecycle probe." }],
        }),
        // DOCX, PPTX, and XLSX are OOXML ZIP containers (PK\u0003\u0004).
        signature: (data) => data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      },
      {
        type: "presentation",
        extension: "pptx",
        artifact: await engine.createPresentation(userId, {
          title: "Chusky Live QA Probe",
          path: `artifacts/live-qa-${randomUUID()}.pptx`,
          slides: [{ title: "Verification", body: "Live artifact lifecycle probe." }],
        }),
        signature: (data) => data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      },
      {
        type: "spreadsheet",
        extension: "xlsx",
        artifact: await engine.createSpreadsheet(userId, {
          title: "Chusky Live QA Probe",
          path: `artifacts/live-qa-${randomUUID()}.xlsx`,
          sheets: [{ name: "Probe", rows: [["Check", "Result"], ["Daytona", "live"], ["Visual QA", "required"]] }],
        }),
        signature: (data) => data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      },
    ];

    const artifactResults: Record<string, string> = {};
    for (const probe of probes) {
      if (!probe.artifact.generated || !probe.artifact.path.endsWith(`.${probe.extension}`) || !probe.artifact.id) {
        throw new Error(`Live Daytona ${probe.extension.toUpperCase()} generation, QA, or artifact registration failed.`);
      }
      const delivery = await engine.streamArtifact(userId, probe.artifact.id);
      const chunks: Buffer[] = [];
      for await (const chunk of delivery.stream as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (delivery.id !== probe.artifact.id || delivery.type !== probe.type || bytes.length !== delivery.size || !probe.signature(bytes)) {
        throw new Error(`Live Daytona ${probe.extension.toUpperCase()} registered-download verification failed.`);
      }
      artifactResults[probe.extension] = "create+qa+register+download passed";
    }
    console.log(JSON.stringify({ liveDaytona: "passed", workspaceState: "created", writeReadList: "passed", artifacts: artifactResults, cleanup: "pending" }));
  } finally {
    if (created) await engine.workspace(userId, "delete");
  }

  console.log(JSON.stringify({ liveDaytona: "passed", cleanup: "deleted" }));
}

void main();
