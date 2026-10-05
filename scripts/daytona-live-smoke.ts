import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  const keepPreview = process.env.DAYTONA_KEEP_PREVIEW === "1";
  let created = false;
  let retainedWorkspaceId = "";
  let retainedPreviewUrl = "";

  try {
    const workspace = await engine.workspace(userId, "create") as { id?: string; networkBlockAll?: boolean; domainAllowList?: string };
    created = true;
    retainedWorkspaceId = String(workspace.id ?? "");
    const networkProbe = await engine.execute(
      userId,
      "for url in https://api.github.com https://example.com https://www.wikipedia.org; do printf '%s ' \"$url\"; curl -L --max-time 10 -sS -o /dev/null -w '%{http_code} %{url_effective} %{errormsg}\\n' \"$url\" || true; done; env | grep -iE '^(http|https|all|no)_proxy=' || true",
      undefined,
      45,
    );
    const computer = await engine.computer(userId, { action: "status" }) as { status?: string };
    const desktopBefore = await engine.computer(userId, { action: "screenshot" }) as { base64?: string };
    if (process.env.DAYTONA_SAVE_SCREENSHOT === "1" && desktopBefore.base64) writeFileSync(".daytona-live-desktop.jpg", Buffer.from(desktopBefore.base64, "base64"));
    const screenshot = await engine.computer(userId, { action: "screenshot" }) as { __daytonaScreenshot?: boolean; sizeBytes?: number };
    if (!computer || typeof computer !== "object" || !screenshot.__daytonaScreenshot) {
      throw new Error("Live Daytona computer screenshot verification failed.");
    }
    await engine.writeFile(userId, probePath, probeContent);
    const read = await engine.readFile(userId, probePath, 200);
    const files = await engine.listFiles(userId, "workspace/.chusky", 2);
    if (read.content !== probeContent || !files.some((file) => file.path === probePath)) {
      throw new Error("Live Daytona create/write/read/list verification failed.");
    }
    const appId = `live-preview-${randomUUID().slice(0, 8)}`;
    const scaffolded = await engine.app(userId, {
      action: "scaffold",
      id: appId,
      framework: "vite-react",
      archetype: "waitlist",
      style: "auto",
      productName: "Fieldnotes",
      brief: "A calm launch space for teams turning a rough idea into a shared plan.",
      audience: "PRODUCT TEAMS",
      primaryAction: "Request early access",
    }) as { id?: string; status?: string };
    if (scaffolded.id !== appId || scaffolded.status !== "scaffolded") {
      throw new Error("Live Daytona app scaffold verification failed.");
    }
    await engine.writeFile(userId, `workspace/apps/${appId}/README.md`, "# Fieldnotes\n\nLive Daytona smoke customization.\n");
    const started = await engine.app(userId, {
      action: "start",
      id: appId,
      expiresInSeconds: 600,
    }) as { url?: string; previewUrl?: string; status?: string; verification?: { status?: string } };
    const previewUrl = String(started.url ?? started.previewUrl ?? "").trim();
    retainedPreviewUrl = previewUrl;
    if (!/^https:\/\//i.test(previewUrl) || started.status !== "running" || started.verification?.status !== "passed") {
      throw new Error("Live Daytona app start did not return a verified HTTPS preview URL.");
    }
    const previewResponse = await fetch(previewUrl, { redirect: "follow" });
    const previewBody = await previewResponse.text();
    if (!previewResponse.ok || !previewBody.includes("<")) {
      throw new Error(`Live Daytona preview URL was not reachable: HTTP ${previewResponse.status}`);
    }
    if (!keepPreview) await engine.app(userId, { action: "stop", id: appId });
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
    console.log(JSON.stringify({ liveDaytona: "passed", workspaceState: "created", sandboxPolicy: { networkBlockAll: workspace.networkBlockAll, domainAllowList: workspace.domainAllowList || "" }, networkProbe: { exitCode: networkProbe.exitCode, output: networkProbe.output }, computerUse: computer.status ?? "available", screenshotBytes: screenshot.sizeBytes ?? 0, writeReadList: "passed", appPreview: { status: "passed", url: previewUrl, httpStatus: previewResponse.status, bodyBytes: previewBody.length }, artifacts: artifactResults, cleanup: "pending" }));
  } finally {
    if (created && !keepPreview) await engine.workspace(userId, "delete");
  }

  console.log(JSON.stringify({ liveDaytona: "passed", cleanup: keepPreview ? "retained" : "deleted", ...(keepPreview ? { workspaceId: retainedWorkspaceId, previewUrl: retainedPreviewUrl } : {}) }));
}

void main();
