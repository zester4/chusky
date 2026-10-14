import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { classifyRetailerFailure, pageLooksUsable, phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";
import { buildSiteEntry, SITE_ADAPTERS, type SiteEntryRequest, type SiteEntryPlan } from "../src/shopping/siteAdapters.js";

type BrowserResult = Record<string, any> & { challenge?: { detected?: boolean; type?: string }; needsUserInteraction?: boolean };
type BrowserMatch = Record<string, any>;

type SmokeCase = { site: string; request: SiteEntryRequest };

const SMOKE_CASES: readonly SmokeCase[] = [
  { site: "target", request: { site: "target", query: "gray shirt" } },
  { site: "walmart", request: { site: "walmart", query: "gray shirt" } },
  { site: "amazon", request: { site: "amazon", query: "wireless keyboard" } },
  { site: "best-buy", request: { site: "best-buy", query: "wireless mouse" } },
  { site: "costco", request: { site: "costco", query: "blue shirt" } },
  { site: "tesco", request: { site: "tesco", query: "coffee" } },
  { site: "jumia-ghana", request: { site: "jumia-ghana", query: "mobile phone" } },
  { site: "instacart", request: { site: "instacart", query: "milk", location: "10001" } },
  { site: "ubereats", request: { site: "ubereats", query: "pizza", location: "10001" } },
  { site: "grubhub", request: { site: "grubhub", query: "pizza", location: "10001" } },
  { site: "just-eat", request: { site: "just-eat", query: "pizza", location: "SW1A 1AA" } },
  { site: "airbnb", request: { site: "airbnb", location: "London" } },
  { site: "booking-com", request: { site: "booking-com", location: "London" } },
  { site: "doordash", request: { site: "doordash", query: "pizza", location: "10001" } },
  { site: "dominos", request: { site: "dominos", query: "pizza", location: "10001" } },
  { site: "expedia", request: { site: "expedia", origin: "Accra", destination: "London" } },
  { site: "united-airlines", request: { site: "united-airlines", origin: "Accra", destination: "London" } },
  { site: "delta", request: { site: "delta", origin: "Accra", destination: "London" } },
  { site: "netflix", request: { site: "netflix", query: "nature documentary" } },
  { site: "disney-plus", request: { site: "disney-plus", query: "nature" } },
] as const;

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
const requestedSite = process.env.E2B_SITE_ADAPTER_SITE?.trim() || process.argv.slice(2).find((value) => !value.startsWith("--"));
const strict = !process.argv.includes("--allow-challenges");
const selectedCases = requestedSite ? SMOKE_CASES.filter((item) => item.site === requestedSite) : SMOKE_CASES;
if (requestedSite && selectedCases.length === 0) throw new Error(`Unknown adapter '${requestedSite}'. Choose: ${SITE_ADAPTERS.map((item) => item.id).join(", ")}`);
if (!apiKey) throw new Error("E2B_API_KEY is required");

function safeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").replace(/(?:token|secret|key)=[^&\s]+/gi, "$1=[redacted]").slice(0, 2_000);
}

function decodeScreenshot(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const base64 = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  try {
    const bytes = Buffer.from(base64, "base64");
    return bytes.length > 100 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function saveScreenshot(root: string, site: string, name: string, value: unknown): Promise<string | undefined> {
  const bytes = decodeScreenshot(value);
  if (!bytes) return undefined;
  const directory = path.join(root, site);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${name}.jpg`);
  await writeFile(target, bytes);
  return target;
}

function challengeDetected(result: BrowserResult | undefined): boolean {
  // `needsUserInteraction` is derived from a detected challenge by the E2B
  // daemon. Do not treat it as an independent challenge signal here: the
  // matrix must distinguish a normal page that needs ordinary interaction
  // from a CAPTCHA/2FA handoff boundary.
  return result?.challenge?.detected === true;
}

function selectorForMatch(match: BrowserMatch): Record<string, unknown> {
  return {
    role: match.role,
    name: match.name,
    index: match.index,
    ...(match.id ? { id: match.id } : {}),
    ...(match.nameAttr ? { nameAttr: match.nameAttr } : {}),
    ...(match.placeholder ? { placeholder: match.placeholder } : {}),
    ...(match.autocomplete ? { autocomplete: match.autocomplete } : {}),
    ...(match.frameIndex !== undefined ? { frameIndex: match.frameIndex } : {}),
    ...(match.frameUrl ? { frameUrl: match.frameUrl } : {}),
  };
}

function matchLabel(match: BrowserMatch): string {
  return `${String(match.name || "")} ${String(match.placeholder || "")} ${String(match.href || "")}`.replace(/\s+/g, " ").trim();
}

function searchControlFor(observed: BrowserResult, entry: SiteEntryPlan): BrowserMatch | undefined {
  const terms = entry.query ? entry.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const matches = (Array.isArray(observed.matches) ? observed.matches : [])
    .filter((item: BrowserMatch) => ["textbox", "combobox"].includes(String(item.role)))
    .filter((item: BrowserMatch) => !/password|email|phone|login|sign in|account/i.test(matchLabel(item)))
    .filter((item: BrowserMatch) => !/facet|filter|number of|brand|category|price|rating|sort|department|select .*search|mouse grip|nameattr.*url/i.test(`${matchLabel(item)} ${String(item.nameAttr || "")}`));
  const scored = matches.map((item: BrowserMatch, index: number) => {
    const label = matchLabel(item).toLowerCase();
    let score = 0;
    if (item.role === "textbox") score += 3;
    if (/search|keyword|what are you looking for|find/i.test(label)) score += 10;
    if (/^(?:search|site search|search this site|search products?)$/i.test(String(item.name || "").trim())) score += 8;
    if (/facet|filter|number of|brand|category|price|rating|sort|department|select .*search/i.test(label)) score -= 12;
    if (terms.some((term) => label.includes(term))) score += 3;
    if (/location|where|origin|destination|from|to|pickup|delivery|postcode|zip/i.test(label)) score += entry.location || entry.origin || entry.destination ? 6 : 1;
    if (item.placeholder) score += 1;
    return { item, score, index };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.score >= 4 ? scored[0].item : undefined;
}

function safeResultLinkFor(observed: BrowserResult, entry: SiteEntryPlan): BrowserMatch | undefined {
  const terms = intentTerms(entry);
  const dangerous = /\b(?:sign in|log in|login|account|cart|bag|checkout|payment|order|subscribe|watch now|play now|rent|buy now|add to cart|delete|remove|skip to|header|footer|menu|filter|sort|next|previous|privacy|terms|help|support|feedback|cookie statement|app logo|select store|shop groceries|about domino)/i;
  const usefulPath = /\/(?:p|product|products|item|dp|site|listing|listings|rooms|hotel|hotels|restaurant|restaurants|movie|movies|title|show|shows|flight|flights|catalog)\b/i;
  let currentPath = "";
  try { currentPath = new URL(String(observed.url || "")).pathname; } catch {}
  const links = (Array.isArray(observed.links) ? observed.links : [])
    .filter((item: BrowserMatch) => item.role === "link" && item.href && item.name)
    .map((item: BrowserMatch, index: number) => {
      let url: URL | undefined;
      try { url = new URL(String(item.href)); } catch { return { item, score: -1, index }; }
      if (url.origin !== entry.origin || url.hash || url.pathname === currentPath || dangerous.test(matchLabel(item))) return { item, score: -1, index };
      const label = matchLabel(item).toLowerCase();
      const matchesIntent = terms.length === 0 || terms.some((term) => label.includes(term) || url!.toString().toLowerCase().includes(term));
      if (!matchesIntent) return { item, score: -1, index };
      let score = usefulPath.test(url.pathname) ? 8 : 0;
      if (terms.length === 0 || terms.some((term) => label.includes(term))) score += 5;
      if (String(item.name).trim().length >= 8) score += 1;
      return { item, score, index };
    }).filter((candidate: { score: number }) => candidate.score >= 5)
    .sort((left: { score: number; index: number }, right: { score: number; index: number }) => right.score - left.score || left.index - right.index);
  return links[0]?.item;
}

function traceFromAgent(result: BrowserResult | undefined): Array<Record<string, unknown>> {
  const agent = result?.agent && typeof result.agent === "object" ? result.agent as Record<string, unknown> : undefined;
  return Array.isArray(agent?.steps)
    ? (agent.steps as Array<Record<string, unknown>>).map((step) => ({ index: step.index, action: step.action, status: step.status, error: step.error, recovery: step.recovery }))
    : [];
}

type InteractionEvidence = {
  trace: Array<Record<string, unknown>>;
  searchControl?: Record<string, unknown>;
  searchSubmitted: boolean;
  resultControl?: Record<string, unknown>;
  resultOpened: boolean;
  scrolled: boolean;
  verified: boolean;
};

async function performReadOnlyInteractionProbe(
  entry: SiteEntryPlan,
  observed: BrowserResult,
  requestBrowser: (request: Record<string, unknown>, phase?: "startup" | "navigation" | "action" | "handoff") => Promise<BrowserResult>,
  capture: (name: string, result: BrowserResult) => Promise<void>,
): Promise<{ observed: BrowserResult; evidence: InteractionEvidence }> {
  const trace: Array<Record<string, unknown>> = [];
  let current = observed;
  let searchSubmitted = false;
  let resultOpened = false;
  let scrolled = false;
  const searchControl = searchControlFor(current, entry);
  let resultControl: BrowserMatch | undefined;

  if (!challengeDetected(current) && searchControl && (entry.query || entry.location || entry.origin || entry.destination)) {
    const value = entry.query || entry.location || entry.origin || entry.destination;
    const steps = [
      { id: "fill-search-or-location", action: "fill", selector: selectorForMatch(searchControl), value },
      { id: "submit-search-or-location", action: "press", selector: selectorForMatch(searchControl), key: "Enter" },
    ];
    const filled = await requestBrowser({ action: "agent", steps, maxSteps: steps.length, maxActions: steps.length, maxDurationMs: 30_000, noProgressLimit: 1, completionAssertions: [] }, "action").catch((error) => ({ error: safeDetail(error) }));
    trace.push(...traceFromAgent(filled));
    if (filled.agent?.completed === true) searchSubmitted = true;
    await capture("03-form-probe", filled);
    current = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
    await capture("04-after-form-probe", current);
  }

  if (!challengeDetected(current)) {
    resultControl = safeResultLinkFor(current, entry);
    if (resultControl) {
      const clicked = await requestBrowser({ action: "click", selector: selectorForMatch(resultControl) }, "action").catch((error) => ({ error: safeDetail(error) }));
      trace.push({ action: "click", target: matchLabel(resultControl), status: clicked.error ? "failed" : "succeeded", error: clicked.error });
      await capture("05-result-click", clicked);
      current = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
      await capture("06-after-result-click", current);
      resultOpened = !clicked.error && pageLooksUsable(current) && String(current.url || "") !== String(observed.url || "");
    }
  }

  if (!challengeDetected(current)) {
    const scrolledResult = await requestBrowser({ action: "scroll", direction: "down", amount: 3 }, "action").catch((error) => ({ error: safeDetail(error) }));
    trace.push({ action: "scroll", status: scrolledResult.error ? "failed" : "succeeded", error: scrolledResult.error });
    await capture("07-after-scroll", scrolledResult);
    current = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
    await capture("08-final-observation", current);
    scrolled = !scrolledResult.error;
  }

  return {
    observed: current,
    evidence: {
      trace,
      ...(searchControl ? { searchControl: selectorForMatch(searchControl) } : {}),
      searchSubmitted,
      ...(resultControl ? { resultControl: selectorForMatch(resultControl) } : {}),
      resultOpened,
      scrolled,
      verified: searchSubmitted || resultOpened || scrolled,
    },
  };
}

function originOf(value: unknown): string | undefined {
  try { return typeof value === "string" ? new URL(value).origin : undefined; } catch { return undefined; }
}

function intentTerms(entry: SiteEntryPlan): string[] {
  return [entry.query, entry.location].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3).slice(0, 8);
}

function renderedErrorPage(value: BrowserResult): boolean {
  const renderedText = `${String(value.title || "")} ${String(value.pageContent || "")}`;
  return /^error$/i.test(String(value.title || "").trim()) || /\b(?:page not found|something went wrong|failed some security checks|access denied|request blocked)\b/i.test(renderedText);
}

function entryEvidence(entry: SiteEntryPlan, observed: BrowserResult, bootstrap: BrowserResult | undefined, interaction: InteractionEvidence, additionalObservations: BrowserResult[] = []): { originMatches: boolean; intentObserved: boolean; pageUsable: boolean; bootstrapCompleted: boolean; interactionVerified: boolean; verified: boolean } {
  const url = String(observed.url || observed.observedUrl || "");
  const text = [observed, ...additionalObservations].map((item) => `${String(item?.url || item?.observedUrl || "")} ${String(item?.title || "")} ${String(item?.pageContent || "")}`).join(" ").toLowerCase();
  const terms = intentTerms(entry);
  const originMatches = originOf(url) === entry.origin;
  const intentObserved = entry.strategy === "bootstrap-search"
    ? (terms.length === 0 || terms.some((term) => text.includes(term)))
    : terms.length === 0 || terms.some((term) => text.includes(term));
  const pageUsable = !renderedErrorPage(observed) && pageLooksUsable({ url, title: observed.title, pageContent: observed.pageContent });
  const agent = bootstrap?.agent && typeof bootstrap.agent === "object" ? bootstrap.agent as Record<string, unknown> : undefined;
  const bootstrapCompleted = entry.steps.length === 0 || agent?.completed === true || bootstrap?.completed === true || interaction.searchSubmitted;
  const interactionVerified = interaction.verified;
  return { originMatches, intentObserved, pageUsable, bootstrapCompleted, interactionVerified, verified: originMatches && intentObserved && pageUsable && bootstrapCompleted && interactionVerified };
}

async function main(): Promise<void> {
  const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-site-adapter-matrix"));
  await mkdir(artifactDir, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  for (const testCase of selectedCases) {
    const startedAt = Date.now();
    let sandbox: Sandbox | undefined;
    let requestBrowser: ((request: Record<string, unknown>, phase?: "startup" | "navigation" | "action" | "handoff") => Promise<BrowserResult>) | undefined;
    let openedScreenshot: string | undefined;
    let finalScreenshot: string | undefined;
    const interactionScreenshotPaths: string[] = [];
    try {
      const entry = buildSiteEntry(testCase.request);
      console.log(JSON.stringify({ site: testCase.site, phase: "sandbox_create", strategy: entry.strategy, url: entry.url }));
      sandbox = await Sandbox.create(template, {
        apiKey,
        timeoutMs: 600_000,
        requestTimeoutMs: phaseTimeoutMs("startup"),
        allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
        network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
        metadata: { app: "chusky", purpose: `site-adapter-smoke-${testCase.site}` },
      });
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
        const responseFile = `/tmp/chusky-site-adapter-${randomUUID()}.json`;
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

      const capture = async (name: string, result: BrowserResult): Promise<void> => {
        const screenshot = await saveScreenshot(artifactDir, testCase.site, name, result?.screenshot);
        if (screenshot) interactionScreenshotPaths.push(screenshot);
      };

      const opened = await requestBrowser({ action: "open", url: entry.url, waitUntil: "commit" }, "navigation");
      openedScreenshot = await saveScreenshot(artifactDir, testCase.site, "01-opened", opened.screenshot);
      const openedObserved = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
      await capture("02-entry-observed", openedObserved);
      let bootstrap: BrowserResult | undefined;
      if (entry.steps.length && !challengeDetected(opened)) {
        bootstrap = await requestBrowser({ action: "agent", steps: entry.steps, maxSteps: entry.steps.length, maxActions: entry.steps.length, maxDurationMs: 45_000, noProgressLimit: 1, completionAssertions: [] }, "action").catch((error) => ({ error: safeDetail(error) }));
      }
      let observed = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
      await capture("02-after-bootstrap", observed);
      const observations = [openedObserved, observed];
      let interaction: InteractionEvidence = { trace: [], searchSubmitted: false, resultOpened: false, scrolled: false, verified: false };

      // A direct result URL is the fast path, not permission to skip the
      // browser interaction. If the route renders an error, return to the
      // public homepage and exercise its visible search control instead.
      if (!challengeDetected(opened) && !challengeDetected(bootstrap) && !challengeDetected(observed) && entry.strategy === "direct-search" && (renderedErrorPage(observed) || !pageLooksUsable(observed))) {
        const homepage = await requestBrowser({ action: "open", url: entry.origin, waitUntil: "commit" }, "navigation");
        await capture("02-homepage-opened", homepage);
        const homepageObserved = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
        await capture("02-homepage-observed", homepageObserved);
        observations.push(homepageObserved);
        if (!challengeDetected(homepageObserved)) {
          const fallbackProbe = await performReadOnlyInteractionProbe(entry, homepageObserved, requestBrowser, capture);
          observed = fallbackProbe.observed;
          interaction = fallbackProbe.evidence;
          observations.push(observed);
        }
      } else if (!challengeDetected(opened) && !challengeDetected(bootstrap) && !challengeDetected(observed)) {
        const probe = await performReadOnlyInteractionProbe(entry, observed, requestBrowser, capture);
        observed = probe.observed;
        interaction = probe.evidence;
        observations.push(observed);
      }
      finalScreenshot = await saveScreenshot(artifactDir, testCase.site, "99-final", observed.screenshot);
      const challenge = [opened, openedObserved, bootstrap, observed, ...observations].some((item) => challengeDetected(item));
      const evidence = entryEvidence(entry, observed, bootstrap, interaction, observations);
      const verified = !challenge && evidence.verified;
      const outcome = challenge ? "challenge_required" : verified ? "verified" : "failed";
      const bootstrapAgent = bootstrap?.agent && typeof bootstrap.agent === "object" ? bootstrap.agent as Record<string, unknown> : undefined;
      const bootstrapTrace = Array.isArray(bootstrapAgent?.steps)
        ? (bootstrapAgent.steps as Array<Record<string, unknown>>).map((step) => ({ index: step.index, action: step.action, status: step.status, error: step.error, recovery: step.recovery }))
        : undefined;
      const result = { site: testCase.site, adapterId: entry.adapterId, strategy: entry.strategy, outcome, verified, challengeDetected: challenge, url: observed.url || opened.url, title: observed.title, entryUrl: entry.url, steps: entry.steps.length, screenshotPaths: [openedScreenshot, ...interactionScreenshotPaths, finalScreenshot].filter(Boolean), evidence, interaction, bootstrapStoppedReason: bootstrapAgent?.stoppedReason, bootstrapTrace, bootstrapError: typeof bootstrap?.error === "string" ? bootstrap.error : undefined, durationMs: Date.now() - startedAt, boundary: "public_read_only_entry_and_observation; no_login_no_credentials_no_payment_no_order" };
      results.push(result);
      await mkdir(path.join(artifactDir, testCase.site), { recursive: true });
      await writeFile(path.join(artifactDir, testCase.site, "evidence.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ site: testCase.site, phase: "complete", outcome, screenshot: finalScreenshot }));
    } catch (error) {
      let screenshotPath: string | undefined;
      if (requestBrowser) {
        const screenshot = await requestBrowser({ action: "screenshot" }, "handoff").catch(() => undefined);
        screenshotPath = await saveScreenshot(artifactDir, testCase.site, "error", screenshot?.screenshot);
      }
      const outcome = "failed";
      const screenshotPaths = [openedScreenshot, finalScreenshot, screenshotPath].filter((value): value is string => Boolean(value));
      const result = { site: testCase.site, outcome, verified: false, error: safeDetail(error), screenshotPath, screenshotPaths, failureClass: classifyRetailerFailure(error), durationMs: Date.now() - startedAt, boundary: "public_read_only_entry_and_observation" };
      results.push(result);
      await mkdir(path.join(artifactDir, testCase.site), { recursive: true });
      await writeFile(path.join(artifactDir, testCase.site, "evidence.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ site: testCase.site, phase: "failed", failureClass: result.failureClass, screenshot: screenshotPath }));
    } finally {
      await sandbox?.kill().catch(() => undefined);
    }
  }

  const report = {
    ok: strict ? results.every((item) => item.verified === true) : results.every((item) => item.verified === true || item.outcome === "challenge_required"),
    strict,
    provider: "e2b-headed-playwright",
    template,
    tested: results.length,
    verified: results.filter((item) => item.verified === true).length,
    challengeRequired: results.filter((item) => item.outcome === "challenge_required").length,
    failed: results.filter((item) => item.outcome === "failed").length,
    screenshots: results.reduce((count, item) => count + (Array.isArray(item.screenshotPaths) ? item.screenshotPaths.length : item.screenshotPath ? 1 : 0), 0),
    noLogin: true,
    noPayment: true,
    noOrderSubmission: true,
    artifactDir,
    results,
  };
  await writeFile(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(`Site adapter live matrix failed: ${safeDetail(error)}`); process.exitCode = 1; });
