import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";

type Platform = { id: string; url: string; category: "groceries" | "restaurant_delivery" | "meal_kit" | "dining_reservations" };

const platforms: Platform[] = [
  { id: "instacart", url: "https://www.instacart.com", category: "groceries" },
  { id: "doordash", url: "https://www.doordash.com", category: "restaurant_delivery" },
  { id: "ubereats", url: "https://www.ubereats.com", category: "restaurant_delivery" },
  { id: "dominos", url: "https://www.dominos.com", category: "restaurant_delivery" },
  { id: "hellofresh", url: "https://www.hellofresh.com", category: "meal_kit" },
  { id: "opentable", url: "https://www.opentable.com", category: "dining_reservations" },
];

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
if (!apiKey) throw new Error("E2B_API_KEY is required");

function detail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").slice(0, 1_500);
}

async function main(): Promise<void> {
  const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-shopping-platform-smoke"));
  await mkdir(artifactDir, { recursive: true });
  let sandbox: Sandbox | undefined;
  const results: Array<Record<string, unknown>> = [];
  try {
    sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: 600_000,
      requestTimeoutMs: phaseTimeoutMs("startup"),
      allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
      network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
      metadata: { app: "chusky", purpose: "shopping-platform-navigation-smoke" },
    });
    const envs = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    const run = (command: string, options: Record<string, unknown> = {}) => sandbox!.commands.run(command, options as never);
    await run("mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
    await run("Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs, requestTimeoutMs: phaseTimeoutMs("startup") });
    await run("fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs, requestTimeoutMs: phaseTimeoutMs("startup") });
    await run("node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...envs, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: phaseTimeoutMs("startup") });
    const readyBy = Date.now() + phaseTimeoutMs("startup");
    while (Date.now() < readyBy) {
      const probe = await run("node -e \"fetch('http://127.0.0.1:8765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"", { envs, timeoutMs: 5_000 }).catch(() => ({ exitCode: 1 }));
      if (probe.exitCode === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const platform of platforms) {
      const responseFile = `/tmp/chusky-platform-${randomUUID()}.json`;
      try {
        const request = { action: "open", url: platform.url, waitUntil: "commit" };
        const opened = await run("node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...envs, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
          timeoutMs: phaseTimeoutMs("navigation"),
          requestTimeoutMs: phaseTimeoutMs("navigation"),
        });
        if (opened.exitCode !== 0) throw new Error(detail(opened.stderr || opened.stdout));
        const wrapper = JSON.parse(opened.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const body = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : opened.stdout;
        const openResult = JSON.parse(body.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const observationRequest = { action: "observe", includePageContent: true, includeLinks: true };
        const observedFile = `/tmp/chusky-platform-${randomUUID()}.json`;
        const observed = await run("node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...envs, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(observationRequest), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: observedFile },
          timeoutMs: phaseTimeoutMs("action"),
          requestTimeoutMs: phaseTimeoutMs("action"),
        });
        if (observed.exitCode !== 0) throw new Error(detail(observed.stderr || observed.stdout));
        const observedWrapper = JSON.parse(observed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const observedBody = typeof observedWrapper.responseFile === "string" ? Buffer.from(await sandbox.files.read(observedWrapper.responseFile, { format: "bytes" })).toString("utf8") : observed.stdout;
        const snapshot = JSON.parse(observedBody.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        results.push({ id: platform.id, category: platform.category, ok: openResult.ok === true && snapshot.ok === true && String(snapshot.pageContent || "").length > 40, url: snapshot.url, title: snapshot.title, pageContentChars: String(snapshot.pageContent || "").length, challenge: snapshot.challenge, needsUserInteraction: snapshot.needsUserInteraction === true });
        await run(`rm -f ${responseFile} ${observedFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
      } catch (error) {
        results.push({ id: platform.id, category: platform.category, ok: false, error: detail(error) });
      }
    }
  } finally {
    await sandbox?.kill().catch(() => undefined);
  }
  const report = { ok: results.every((item) => item.ok === true), tested: results.length, scope: "public_navigation_and_challenge_detection_only", neverSubmittedOrder: true, neverSubmittedPayment: true, results };
  const reportPath = path.join(artifactDir, "shopping-platform-smoke.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(detail(error)); process.exitCode = 1; });
