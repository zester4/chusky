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
  let created = false;

  try {
    const workspace = await engine.workspace(userId, "create") as { id?: string; networkBlockAll?: boolean; domainAllowList?: string };
    created = true;
    const networkProbe = await engine.execute(
      userId,
      "for url in https://api.github.com https://example.com https://www.wikipedia.org; do printf '%s ' \"$url\"; curl -L --max-time 10 -sS -o /dev/null -w '%{http_code} %{url_effective} %{errormsg}\\n' \"$url\" || true; done; env | grep -iE '^(http|https|all|no)_proxy=' || true",
      undefined,
      45,
    );
    const computer = await engine.computer(userId, { action: "status" }) as { status?: string };
    const browser = await engine.browser(userId, { action: "state", maxDepth: 2 }) as { action?: string; loadState?: string; sandboxId?: string };
    const desktopBefore = await engine.computer(userId, { action: "screenshot" }) as { base64?: string };
    if (process.env.DAYTONA_SAVE_SCREENSHOT === "1" && desktopBefore.base64) writeFileSync(".daytona-live-desktop.jpg", Buffer.from(desktopBefore.base64, "base64"));
    const browserOpen = await engine.browser(userId, { action: "open", url: "https://api.github.com" }) as { opened?: string; observationMethod?: string; verificationRequired?: boolean; inspection?: unknown };
    const screenshot = await engine.computer(userId, { action: "screenshot" }) as { __daytonaScreenshot?: boolean; sizeBytes?: number };
    if (!computer || typeof computer !== "object" || !browser || browser.action !== "state" || browserOpen.opened !== "https://api.github.com" || browserOpen.verificationRequired !== true || !screenshot.__daytonaScreenshot) {
      throw new Error("Live Daytona Computer Use/browser verification failed.");
    }
    const browserPages: Array<Record<string, unknown>> = [];
    for (const url of ["https://api.github.com", "https://example.com", "https://www.wikipedia.org"]) {
      try {
        const opened = await engine.browser(userId, { action: "open", url }) as { opened?: string; observedUrl?: string; observationMethod?: string; loadState?: string; inspection?: unknown };
        const pageScreenshot = await engine.browser(userId, { action: "screenshot" }) as { __daytonaScreenshot?: boolean; sizeBytes?: number };
        if (process.env.DAYTONA_SAVE_SCREENSHOT === "1" && url === "https://example.com" && (pageScreenshot as { base64?: string }).base64) writeFileSync(".daytona-example.jpg", Buffer.from((pageScreenshot as { base64: string }).base64, "base64"));
        browserPages.push({
          requested: url,
          opened: opened.opened,
          observedUrl: opened.observedUrl,
          observationMethod: opened.observationMethod,
          loadState: opened.loadState,
          screenshotBytes: pageScreenshot.sizeBytes ?? 0,
          inspectionAvailable: Boolean(opened.inspection && typeof opened.inspection === "object" && !("unavailable" in (opened.inspection as Record<string, unknown>))),
        });
      } catch (error) {
        browserPages.push({ requested: url, error: String(error).slice(0, 300) });
      }
    }
    let clickProbe: Record<string, unknown> = { status: "not_run" };
    let clickMatches: unknown;
    try {
      await engine.browser(userId, { action: "open", url: "https://github.com" });
      const found = await engine.browser(userId, { action: "find", role: "link", name: "Sign in", nameMatch: "substring", limit: 3 }) as { matches?: Array<{ id?: string }> };
      const matches = Array.isArray(found.matches) ? found.matches : [];
      clickMatches = matches.slice(0, 3);
      const firstMatch = matches.find((match) => match && typeof match === "object") as { id?: string; nodeId?: string } | undefined;
      const nodeId = firstMatch?.nodeId ?? firstMatch?.id;
      if (!nodeId) {
        clickProbe = { status: "no_accessible_link", matches: matches.slice(0, 3) };
      } else {
        const invoked = await engine.browser(userId, { action: "invoke", nodeId, nodeAction: "click" });
        const after = await engine.browser(userId, { action: "state", maxDepth: 2 }) as { observedUrl?: string; observationMethod?: string };
        clickProbe = { status: "clicked", invoked: Boolean(invoked), observedUrl: after.observedUrl, observationMethod: after.observationMethod };
      }
    } catch (error) {
      clickProbe = { status: "error", error: String(error).slice(0, 300), matches: clickMatches };
    }
    await engine.writeFile(userId, probePath, probeContent);
    const read = await engine.readFile(userId, probePath, 200);
    const files = await engine.listFiles(userId, "workspace/.chusky", 2);
    if (read.content !== probeContent || !files.some((file) => file.path === probePath)) {
      throw new Error("Live Daytona create/write/read/list verification failed.");
    }
    const probes: Array<{ type: "pdf" | "docx" | "presentation" | "spreadsheet"; extension: "pdf" | "docx" | "pptx" | "xlsx"; artifact: any; signature: (data: Buffer) => boolean }> = process.env.DAYTONA_BROWSER_ONLY === "1" ? [] : [
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
    console.log(JSON.stringify({ liveDaytona: "passed", workspaceState: "created", sandboxPolicy: { networkBlockAll: workspace.networkBlockAll, domainAllowList: workspace.domainAllowList || "" }, networkProbe: { exitCode: networkProbe.exitCode, output: networkProbe.output }, computerUse: computer.status ?? "available", browserState: browser.loadState ?? "unknown", browserOpen: { requested: browserOpen.opened, observationMethod: browserOpen.observationMethod ?? "unknown", inspectionAvailable: Boolean(browserOpen.inspection && typeof browserOpen.inspection === "object" && !("unavailable" in (browserOpen.inspection as Record<string, unknown>))) }, browserPages, clickProbe, screenshotBytes: screenshot.sizeBytes ?? 0, writeReadList: "passed", artifacts: artifactResults, cleanup: "pending" }));
  } finally {
    if (created) await engine.workspace(userId, "delete");
  }

  console.log(JSON.stringify({ liveDaytona: "passed", cleanup: "deleted" }));
}

void main();
