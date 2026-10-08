import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";

type Provider = { id: "uber" | "lyft"; url: string };
type Match = { role: string; name: string; index: number; [key: string]: unknown };
type BrowserResult = Record<string, any>;

const providers: Provider[] = [
  { id: "uber", url: "https://www.uber.com/go/reserve/home" },
  { id: "lyft", url: "https://ride.lyft.com/" },
];
const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
if (!apiKey) throw new Error("E2B_API_KEY is required");

function safeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").slice(0, 2_000);
}

function selectorFor(item: Match): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    role: item.role, name: item.name, index: item.index, id: item.id, nameAttr: item.nameAttr,
    placeholder: item.placeholder, autocomplete: item.autocomplete, inputType: item.inputType,
    tagName: item.tagName, frameIndex: item.frameIndex, frameUrl: item.frameUrl,
    observationId: item.observationId, pageGeneration: item.pageGeneration,
  }).filter(([, value]) => value !== undefined && value !== ""));
}

function locationMatch(matches: Match[], kind: "pickup" | "dropoff"): Match | undefined {
  const patterns = kind === "pickup"
    ? [/pickup/i, /pick\s*up/i, /origin/i, /starting/i, /\bfrom\b/i]
    : [/dropoff/i, /drop\s*off/i, /destination/i, /ending/i, /where.*going/i, /\bto\b/i];
  const candidates = matches.filter((item) => ["textbox", "combobox"].includes(item.role) && patterns.some((pattern) => pattern.test(item.name)));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function locationPair(matches: Match[]): { pickup: Match; dropoff: Match } | undefined {
  const pickup = locationMatch(matches, "pickup");
  const dropoff = locationMatch(matches, "dropoff");
  if (pickup && dropoff && pickup.index !== dropoff.index) return { pickup, dropoff };
  // Uber currently renders two identical "Search for a location" comboboxes.
  // Their accessible names do not reveal direction, so use DOM order only
  // when exactly two location-like controls are present.
  const generic = matches
    .filter((item) => ["textbox", "combobox"].includes(item.role) && /\b(?:search for a location|location|address)\b/i.test(item.name))
    .sort((left, right) => left.index - right.index);
  return generic.length === 2 && generic[0].index !== generic[1].index
    ? { pickup: generic[0], dropoff: generic[1] }
    : undefined;
}

async function main() {
  const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-ride-smoke"));
  await mkdir(artifactDir, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  for (const provider of providers) {
    let sandbox: Sandbox | undefined;
    const checks: Array<Record<string, unknown>> = [];
    const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail ? { detail: safeDetail(detail) } : {}) });
    try {
      sandbox = await Sandbox.create(template, {
        apiKey,
        timeoutMs: 300_000,
        requestTimeoutMs: phaseTimeoutMs("startup"),
        allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
        network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
        metadata: { app: "chusky", purpose: `ride-form-readonly-smoke-${provider.id}` },
      });
      const run = async (label: string, command: string, options: Record<string, unknown> = {}) => {
        try { return await sandbox!.commands.run(command, options as never); }
        catch (error) { throw new Error(`${label}: ${safeDetail(error)}`); }
      };
      const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
      await run("runtime directory", "mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
      await run("Xvfb", "Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("Fluxbox", "fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("browser daemon", "node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...displayEnv, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: phaseTimeoutMs("startup") });

      const requestBrowser = async (request: Record<string, unknown>, phase: "navigation" | "action" = "action"): Promise<BrowserResult> => {
        const responseFile = `/tmp/chusky-ride-${randomUUID()}.json`;
        const result = await run("browser client", "node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
          timeoutMs: phaseTimeoutMs(phase), requestTimeoutMs: phaseTimeoutMs(phase),
        });
        if (result.exitCode !== 0) throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 4_000));
        const wrapper = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const body = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox!.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : result.stdout;
        await sandbox!.commands.run(`rm -f ${responseFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
        const parsed = JSON.parse(body.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}") as BrowserResult;
        if (parsed.ok !== true) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 1_000)}`);
        return parsed;
      };

      const opened = await requestBrowser({ action: "open", url: provider.url }, "navigation");
      const initial = await requestBrowser({ action: "snapshot", includePageContent: true });
      check("public ride page opened", opened.url === provider.url && String(initial.title || "").length > 0, { url: opened.url, title: initial.title, challenge: initial.challenge });
      if (initial.challenge?.detected === true) {
        check("provider challenge is surfaced instead of bypassed", true, initial.challenge);
        results.push({ provider: provider.id, url: provider.url, status: "challenge", checks });
        continue;
      }

      const matches = (initial.matches || []) as Match[];
      const pair = locationPair(matches);
      if (!pair) {
        check("pickup and dropoff controls exposed", false, { controls: matches.filter((item) => ["textbox", "combobox"].includes(item.role)).map((item) => ({ role: item.role, name: item.name })) });
        results.push({ provider: provider.id, url: provider.url, status: "form_unavailable", checks });
        continue;
      }
      const { pickup, dropoff } = pair;
      check("pickup and dropoff controls exposed", true, { pickup: pickup.name, dropoff: dropoff.name });

      const pickupValue = "Los Angeles International Airport";
      const dropoffValue = "Santa Monica Pier";
      const pickupResult = await requestBrowser({ action: "fill", selector: selectorFor(pickup), value: pickupValue });
      const dropoffResult = await requestBrowser({ action: "fill", selector: selectorFor(dropoff), value: dropoffValue });
      const afterFill = await requestBrowser({ action: "snapshot", includePageContent: true });
      const suggestionButtons = await requestBrowser({ action: "find", role: "button", name: "Santa Monica", nameMatch: "substring", limit: 20 });
      const afterScreenshot = await requestBrowser({ action: "screenshot" });
      const screenshotPath = path.join(artifactDir, `${provider.id}-after-location-fill.jpg`);
      if (typeof afterScreenshot.screenshot === "string") await writeFile(screenshotPath, Buffer.from(afterScreenshot.screenshot, "base64"));
      const afterDetail = { pickup: pickupResult.formState, dropoff: dropoffResult.formState, pageContent: String(afterFill.pageContent || "").slice(0, 2_000), suggestionButtons: suggestionButtons.matches, matches: (afterFill.matches || []).filter((item: Match) => ["button", "option", "listitem", "link"].includes(item.role)).slice(0, 20), screenshotPath };
      const tripReviewText = String(afterFill.pageContent || "");
      check("pickup is committed after autocomplete", pickupResult.formState?.autocompleteSelected === true || /From\s+Los Angeles International Airport/i.test(tripReviewText), afterDetail);
      check("dropoff is committed after autocomplete", dropoffResult.formState?.autocompleteSelected === true || /To\s+Santa Monica Pier/i.test(tripReviewText), afterDetail);
      check("ride request was not submitted", true, "The harness never clicks request/confirm controls.");
      results.push({ provider: provider.id, url: provider.url, status: checks.every((item) => item.ok) ? "passed" : "failed", checks });
    } catch (error) {
      check("smoke execution", false, error);
      results.push({ provider: provider.id, url: provider.url, status: "error", checks });
    } finally {
      if (sandbox) await sandbox.kill().catch(() => undefined);
    }
  }

  const report = { ok: results.every((item) => item.status === "passed"), template, results, generatedAt: new Date().toISOString() };
  const reportPath = path.join(artifactDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(safeDetail(error)); process.exitCode = 1; });
