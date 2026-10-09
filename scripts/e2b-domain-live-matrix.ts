import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { classifyRetailerFailure, pageLooksUsable, phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";

type Domain = {
  id: string;
  category: "flights" | "stays" | "telecom" | "streaming";
  provider: string;
  url: string;
};

/**
 * Public, read-only domain coverage. This deliberately does not log in, fill
 * personal data, change an account, add a product, book, purchase, or submit.
 * A successful row proves the E2B runtime can reach and observe the provider;
 * it does not claim provider-specific end-to-end completion.
 */
export const DOMAIN_SITES: Domain[] = [
  { id: "united-airlines", category: "flights", provider: "United Airlines", url: "https://www.united.com/en/us" },
  { id: "delta", category: "flights", provider: "Delta", url: "https://www.delta.com" },
  { id: "american-airlines", category: "flights", provider: "American Airlines", url: "https://www.aa.com" },
  { id: "southwest", category: "flights", provider: "Southwest", url: "https://www.southwest.com" },
  { id: "airbnb", category: "stays", provider: "Airbnb", url: "https://www.airbnb.com" },
  { id: "booking-com", category: "stays", provider: "Booking.com", url: "https://www.booking.com" },
  { id: "verizon", category: "telecom", provider: "Verizon", url: "https://www.verizon.com" },
  { id: "t-mobile", category: "telecom", provider: "T-Mobile", url: "https://www.t-mobile.com" },
  { id: "att", category: "telecom", provider: "AT&T", url: "https://www.att.com" },
  { id: "netflix", category: "streaming", provider: "Netflix", url: "https://www.netflix.com" },
  { id: "disney-plus", category: "streaming", provider: "Disney+", url: "https://www.disneyplus.com" },
  { id: "max", category: "streaming", provider: "Max", url: "https://www.max.com" },
];

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
const requestedSite = process.env.E2B_DOMAIN_SITE?.trim() || process.argv.slice(2).find((value) => !value.startsWith("--"));
const selectedSites = requestedSite ? DOMAIN_SITES.filter((site) => site.id === requestedSite) : DOMAIN_SITES;
if (requestedSite && selectedSites.length === 0) throw new Error(`Unknown domain '${requestedSite}'. Choose: ${DOMAIN_SITES.map((site) => site.id).join(", ")}`);
if (!apiKey) throw new Error("E2B_API_KEY is required");
const sandboxCreateTimeoutMs = (() => {
  const configured = Number(process.env.E2B_DOMAIN_SANDBOX_CREATE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? Math.max(30_000, Math.min(240_000, configured)) : 150_000;
})();
const sandboxLifetimeMs = (() => {
  const configured = Number(process.env.E2B_DOMAIN_SANDBOX_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 180_000 ? Math.min(configured, 15 * 60_000) : 600_000;
})();

function safeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").slice(0, 2_000);
}

function decodeScreenshot(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const base64 = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  try {
    const image = Buffer.from(base64, "base64");
    return image.length > 0 ? image : undefined;
  } catch {
    return undefined;
  }
}

async function saveScreenshot(artifactDir: string, siteId: string, value: unknown): Promise<string | undefined> {
  const image = decodeScreenshot(value);
  if (!image) return undefined;
  const siteDir = path.join(artifactDir, siteId);
  await mkdir(siteDir, { recursive: true });
  const screenshotPath = path.join(siteDir, "screenshot.jpg");
  await writeFile(screenshotPath, image);
  return screenshotPath;
}

async function saveSiteEvidence(artifactDir: string, siteId: string, evidence: Record<string, unknown>): Promise<string> {
  const siteDir = path.join(artifactDir, siteId);
  await mkdir(siteDir, { recursive: true });
  const evidencePath = path.join(siteDir, "evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return evidencePath;
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-domain-live-matrix"));
  await mkdir(artifactDir, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  for (const site of selectedSites) {
    console.log(JSON.stringify({ id: site.id, provider: site.provider, phase: "start" }));
    let sandbox: Sandbox | undefined;
    let requestBrowser: ((request: Record<string, unknown>, phase?: "startup" | "navigation" | "action" | "handoff") => Promise<Record<string, any>>) | undefined;
    const startedAt = Date.now();
    try {
      sandbox = await withDeadline(Sandbox.create(template, {
        apiKey,
        timeoutMs: sandboxLifetimeMs,
        requestTimeoutMs: phaseTimeoutMs("startup"),
        allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
        network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
        metadata: { app: "chusky", purpose: `domain-public-navigation-${site.id}` },
      }), sandboxCreateTimeoutMs, "E2B sandbox creation");
      const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
      const run = (command: string, options: Record<string, unknown> = {}) => sandbox!.commands.run(command, options as never);
      await run("mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
      await run("Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...displayEnv, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: phaseTimeoutMs("startup") });

      const deadline = Date.now() + phaseTimeoutMs("startup");
      let ready = false;
      while (Date.now() < deadline) {
        const probe = await run("node -e \"fetch('http://127.0.0.1:8765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"", { timeoutMs: 5_000 }).catch(() => ({ exitCode: 1 }));
        if (probe.exitCode === 0) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error("browser daemon did not become ready before startup deadline");

      requestBrowser = async (request, phase = "action") => {
        const responseFile = `/tmp/chusky-domain-${randomUUID()}.json`;
        const response = await run("node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
          timeoutMs: phaseTimeoutMs(phase),
          requestTimeoutMs: phaseTimeoutMs(phase),
        });
        if (response.exitCode !== 0) throw new Error([response.stderr, response.stdout].filter(Boolean).join("\n").slice(0, 4_000));
        const wrapper = JSON.parse(response.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const body = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox!.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : response.stdout;
        await run(`rm -f ${responseFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
        const parsed = JSON.parse(body.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        if (parsed.ok !== true) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 1_000)}`);
        return parsed;
      };

      const opened = await requestBrowser({ action: "open", url: site.url, waitUntil: "commit" }, "navigation");
      const observed = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
      const challengeDetected = observed.challenge?.detected === true || observed.needsUserInteraction === true;
      const usable = pageLooksUsable(observed);
      const diagnostics = await requestBrowser({ action: "diagnostics" }, "handoff").catch((error) => ({ error: safeDetail(error) }));
      const screenshotPath = await saveScreenshot(artifactDir, site.id, observed.screenshot);
      const result = {
        id: site.id,
        provider: site.provider,
        category: site.category,
        ok: usable || challengeDetected,
        outcome: challengeDetected ? "challenge_required" : usable ? "public_observation_verified" : "unusable_page",
        url: observed.url || opened.url,
        title: observed.title,
        pageContentChars: String(observed.pageContent || "").length,
        screenshotCaptured: typeof observed.screenshot === "string" && observed.screenshot.length > 0,
        ...(screenshotPath ? { screenshotPath } : {}),
        challengeDetected,
        diagnosticsCaptured: !Boolean((diagnostics as Record<string, unknown>).error),
        sandboxId: sandbox.sandboxId,
        durationMs: Date.now() - startedAt,
        boundary: "no_login_no_personal_data_no_write_no_booking_no_purchase_no_plan_change",
      };
      results.push(result);
      const evidencePath = await saveSiteEvidence(artifactDir, site.id, { ...result, diagnostics: diagnostics as Record<string, unknown> });
      result.evidencePath = evidencePath;
      console.log(JSON.stringify({ id: site.id, provider: site.provider, phase: "complete", outcome: results.at(-1)?.outcome }));
    } catch (error) {
      const diagnostics = requestBrowser ? await requestBrowser({ action: "diagnostics" }, "handoff").catch((item) => ({ error: safeDetail(item) })) : {};
      const screenshot = requestBrowser ? await requestBrowser({ action: "screenshot" }, "handoff").catch(() => undefined) : undefined;
      const screenshotPath = await saveScreenshot(artifactDir, site.id, (screenshot as Record<string, unknown> | undefined)?.screenshot);
      const evidence = {
        diagnostics,
        screenshotCaptured: Boolean((screenshot as Record<string, unknown> | undefined)?.screenshot),
        ...(screenshotPath ? { screenshotPath } : {}),
      };
      const diagnosticResult = evidence.diagnostics as Record<string, unknown> | undefined;
      const challenge = diagnosticResult?.challenge as Record<string, unknown> | undefined;
      const challengeDetected = challenge?.detected === true || diagnosticResult?.needsUserInteraction === true;
      if (challengeDetected) {
        const result = { id: site.id, provider: site.provider, category: site.category, ok: true, outcome: "challenge_required", challengeDetected: true, failureClass: "challenge", error: safeDetail(error), evidence, sandboxId: sandbox?.sandboxId, durationMs: Date.now() - startedAt, boundary: "no_login_no_personal_data_no_write_no_booking_no_purchase_no_plan_change" };
        results.push(result);
        const evidencePath = await saveSiteEvidence(artifactDir, site.id, { ...result, diagnostics });
        result.evidencePath = evidencePath;
        console.log(JSON.stringify({ id: site.id, provider: site.provider, phase: "complete", outcome: "challenge_required" }));
      } else {
        const result = { id: site.id, provider: site.provider, category: site.category, ok: false, outcome: "failed", failureClass: classifyRetailerFailure(error), error: safeDetail(error), evidence, sandboxId: sandbox?.sandboxId, durationMs: Date.now() - startedAt };
        results.push(result);
        const evidencePath = await saveSiteEvidence(artifactDir, site.id, { ...result, diagnostics });
        result.evidencePath = evidencePath;
        console.log(JSON.stringify({ id: site.id, provider: site.provider, phase: "failed", failureClass: classifyRetailerFailure(error) }));
      }
    } finally {
      await sandbox?.kill().catch(() => undefined);
    }
  }

  const report = {
    ok: results.every((item) => item.ok === true),
    publicObservationVerified: results.filter((item) => item.outcome === "public_observation_verified").length,
    challengeRequired: results.filter((item) => item.outcome === "challenge_required").length,
    tested: results.length,
    template,
    scope: "public_navigation_and_observation_only",
    neverSubmittedOrder: true,
    neverSubmittedPayment: true,
    neverChangedAccountOrPlan: true,
    results,
  };
  const reportPath = path.join(artifactDir, "domain-live-matrix.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(safeDetail(error)); process.exitCode = 1; });
