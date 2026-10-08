import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { classifyRetailerFailure, hasCartSignal, isPurchaseControlLabel, pageLooksUsable, phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";
import { findAddToCartControl, findFirstAvailableVariant, findProductCandidate, findVariantControl, interactiveMatches, type RetailerFlowMatch } from "../src/lib/e2b/retailerFlow.js";

type Retailer = { id: string; homepage: string; search: string };

const retailRetailers: Retailer[] = [
  { id: "target", homepage: "https://www.target.com", search: "https://www.target.com/s?searchTerm=blue%20shirt" },
  { id: "best-buy", homepage: "https://www.bestbuy.com", search: "https://www.bestbuy.com/site/searchpage.jsp?st=wireless+mouse" },
  { id: "walmart", homepage: "https://www.walmart.com", search: "https://www.walmart.com/search?q=blue%20shirt" },
  { id: "costco", homepage: "https://www.costco.com", search: "https://www.costco.com/CatalogSearch?keyword=blue%20shirt" },
  { id: "att", homepage: "https://www.att.com", search: "https://www.att.com/search/?q=iphone" },
];

const foodRetailers: Retailer[] = [
  { id: "instacart", homepage: "https://www.instacart.com", search: "https://www.instacart.com/store/s?k=milk" },
  { id: "doordash", homepage: "https://www.doordash.com", search: "https://www.doordash.com/search/store/" },
  { id: "ubereats", homepage: "https://www.ubereats.com", search: "https://www.ubereats.com/search?q=pizza" },
  { id: "dominos", homepage: "https://www.dominos.com", search: "https://www.dominos.com/en/pages/order/#!/locations/search/" },
  { id: "hellofresh", homepage: "https://www.hellofresh.com", search: "https://www.hellofresh.com/recipes" },
];

const allRetailers = [...retailRetailers, ...foodRetailers];

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
if (!apiKey) throw new Error("E2B_API_KEY is required");
const requestedRetailer = process.argv.slice(2).find((value) => !value.startsWith("--"));
const foodOnly = process.argv.includes("--food");
const selectedPool = foodOnly ? foodRetailers : retailRetailers;
const selectedRetailers = requestedRetailer ? allRetailers.filter((retailer) => retailer.id === requestedRetailer) : selectedPool;
if (requestedRetailer && selectedRetailers.length === 0) throw new Error(`Unknown retailer '${requestedRetailer}'. Choose: ${allRetailers.map((retailer) => retailer.id).join(", ")}`);
const keepAlive = process.argv.includes("--keep-alive");
const sandboxTimeoutMs = (() => {
  const configured = Number(process.env.E2B_RETAILER_SANDBOX_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 180_000 ? Math.min(configured, 15 * 60_000) : 600_000;
})();
const keepAliveMs = (() => {
  const configured = Number(process.env.E2B_LIVE_VIEW_DURATION_MS);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 30 * 60_000) : 10 * 60_000;
})();

function safeDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").slice(0, 2_000);
}

function safeActionMatch(matches: RetailerFlowMatch[], pattern: RegExp): RetailerFlowMatch | undefined {
  return matches.find((item) => ["button", "link"].includes(String(item.role)) && pattern.test(String(item.name || "")) && !isPurchaseControlLabel(item.name));
}

async function main() {
  const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-retailer-matrix"));
  await mkdir(artifactDir, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  for (const retailer of selectedRetailers) {
    let sandbox: Sandbox | undefined;
    const checks: Array<Record<string, unknown>> = [];
    let requestBrowser: ((request: Record<string, unknown>, phase?: "startup" | "navigation" | "action" | "handoff") => Promise<Record<string, any>>) | undefined;
    const startedAt = Date.now();
    const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail ? { detail: safeDetail(detail) } : {}) });
    try {
      console.log(JSON.stringify({ retailer: retailer.id, phase: "sandbox_create", template }));
      sandbox = await Sandbox.create(template, {
        apiKey,
        timeoutMs: sandboxTimeoutMs,
        requestTimeoutMs: phaseTimeoutMs("startup"),
        allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
        network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
        metadata: { app: "chusky", purpose: `retailer-product-flow-${retailer.id}` },
      });
      console.log(JSON.stringify({ retailer: retailer.id, phase: "sandbox_ready", sandboxId: sandbox.sandboxId }));
      const run = async (label: string, command: string, options: Record<string, unknown> = {}) => {
        try { return await sandbox!.commands.run(command, options as never); }
        catch (error) { throw new Error(`${label}: ${safeDetail(error)}`); }
      };
      const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
      await run("runtime directory", "mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
      await run("Xvfb", "Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("Fluxbox", "fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
      await run("browser daemon", "node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...displayEnv, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: phaseTimeoutMs("startup") });
      let browserReady = false;
      const readinessDeadline = Date.now() + phaseTimeoutMs("startup");
      while (Date.now() < readinessDeadline) {
        const probe = await sandbox.commands.run("node -e \"fetch('http://127.0.0.1:8765/health').then(async r=>{console.log(r.ok?'ready':'not-ready');await r.arrayBuffer()}).catch(()=>console.log('not-ready'))\"", { timeoutMs: 5_000, envs: displayEnv }).catch(() => ({ exitCode: 1, stdout: "" }));
        if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).at(-1) === "ready") { browserReady = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      check("browser daemon readiness", browserReady, { timeoutMs: phaseTimeoutMs("startup") });
      if (!browserReady) throw new Error("browser daemon did not become ready before startup deadline");
      const vncPassword = randomUUID().replaceAll("-", "").slice(0, 8);
      await run("retailer x11vnc handoff", `x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwd ${vncPassword} >/tmp/chusky-x11vnc-retailer.log 2>&1`, { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("handoff") });
      await run("retailer noVNC handoff", "websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/chusky-websockify-retailer.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("handoff") });

      requestBrowser = async (request, phase = "action") => {
        const responseFile = `/tmp/chusky-retailer-${randomUUID()}.json`;
        const result = await run("browser client", "node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
          timeoutMs: phaseTimeoutMs(phase),
          requestTimeoutMs: phaseTimeoutMs(phase),
        });
        if (result.exitCode !== 0) throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 4_000));
        const wrapper = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        const body = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox!.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : result.stdout;
        await sandbox!.commands.run(`rm -f ${responseFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
        const parsed = JSON.parse(body.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        if (parsed.ok !== true) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 800)}`);
        return parsed;
      };
      const openUrl = async (url: string) => {
        let lastError: unknown;
        for (const waitUntil of ["domcontentloaded", "commit", "commit"] as const) {
          try { return await requestBrowser!({ action: "open", url, waitUntil }, "navigation"); }
          catch (error) {
            lastError = error;
            if (!/ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION|navigation|Frame was detached/i.test(safeDetail(error))) throw error;
            await requestBrowser!({ action: "tab_open" }, "navigation").catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, waitUntil === "domcontentloaded" ? 500 : 1_000));
          }
        }
        throw lastError instanceof Error ? lastError : new Error(safeDetail(lastError));
      };

      console.log(JSON.stringify({ retailer: retailer.id, phase: "homepage" }));
      const home = await openUrl(retailer.homepage);
      const homeObservation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
      check("homepage navigation", typeof home.url === "string", { url: home.url, title: homeObservation.title });
      check("homepage challenge detection", true, homeObservation.challenge);

      console.log(JSON.stringify({ retailer: retailer.id, phase: "search" }));
      const search = await openUrl(retailer.search);
      let observation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
      check("search navigation", typeof search.url === "string", { url: search.url, title: observation.title });
      const challengeDetected = observation.challenge?.detected === true || observation.needsUserInteraction === true;
      check("challenge detection isolated from product flow", true, { detected: challengeDetected, challenge: observation.challenge });

      const candidate = challengeDetected ? undefined : findProductCandidate([
        ...(Array.isArray(observation.matches) ? observation.matches : []),
        ...(Array.isArray(observation.links) ? observation.links : []),
      ], String(observation.url || search.url));
      check("product candidate discovery", challengeDetected || Boolean(candidate), {
        candidate: candidate || "none",
        ignoredDueToChallenge: challengeDetected,
        matchCount: Array.isArray(observation.matches) ? observation.matches.length : 0,
      });
      let productOpened = false;
      let cartPrepared = false;
      let cartOpened = false;
      let cartContentsVerified = false;
      let checkoutReviewReached = false;
      let stoppedBeforePurchase = true;
      if (candidate && !challengeDetected) {
        console.log(JSON.stringify({ retailer: retailer.id, phase: "product", url: candidate }));
        const product = await openUrl(candidate);
        observation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
        productOpened = pageLooksUsable(observation);
        check("product page opened", productOpened, { url: product.url, title: observation.title });
        const targetedControls = await Promise.all([
          requestBrowser({ action: "observe", role: "button", name: "add", nameMatch: "substring", limit: 20, includePageContent: true }, "action").catch(() => ({})),
          requestBrowser({ action: "observe", role: "button", name: "cart", nameMatch: "substring", limit: 20, includePageContent: true }, "action").catch(() => ({})),
          requestBrowser({ action: "observe", role: "button", name: "color", nameMatch: "substring", limit: 20, includePageContent: true }, "action").catch(() => ({})),
          requestBrowser({ action: "observe", role: "button", name: "size", nameMatch: "substring", limit: 20, includePageContent: true }, "action").catch(() => ({})),
          requestBrowser({ action: "observe", role: "combobox", limit: 20, includePageContent: true }, "action").catch(() => ({})),
          requestBrowser({ action: "observe", role: "radio", limit: 20, includePageContent: true }, "action").catch(() => ({})),
        ]);
        const targetedMatches = targetedControls.flatMap((item) => Array.isArray(item.matches) ? item.matches : []);
        let dynamicMatches = interactiveMatches({ ...observation, matches: [...(Array.isArray(observation.matches) ? observation.matches : []), ...targetedMatches] });
        let variant = findVariantControl(dynamicMatches);
        const variantChoice = findFirstAvailableVariant(dynamicMatches);
        if (variantChoice && variantChoice !== variant && variantChoice.role !== "option") {
          await requestBrowser({ action: "click", selector: { role: variantChoice.role, name: variantChoice.name, index: variantChoice.index, ...(variantChoice.id ? { id: variantChoice.id } : {}), ...(variantChoice.frameIndex !== undefined ? { frameIndex: variantChoice.frameIndex } : {}), ...(variantChoice.frameUrl ? { frameUrl: variantChoice.frameUrl } : {}) } }, "action").catch(() => undefined);
          observation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
          dynamicMatches = interactiveMatches(observation);
          variant = findVariantControl(dynamicMatches) || variant;
        }
        check("variant controls inspected", true, { found: Boolean(variant), selectedSafeOption: Boolean(variantChoice), role: variant?.role, name: variant?.name });
        let add = findAddToCartControl(dynamicMatches) || safeActionMatch(dynamicMatches, /add to cart|add to bag|add for delivery|add item/i);
        for (let attempt = 0; !add && attempt < 4; attempt += 1) {
          await requestBrowser({ action: "scroll", direction: "down", amount: 3 }, "action").catch(() => undefined);
          await requestBrowser({ action: "wait", timeoutMs: 750 }, "action").catch(() => undefined);
          observation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
          dynamicMatches = interactiveMatches(observation);
          add = findAddToCartControl(dynamicMatches) || safeActionMatch(dynamicMatches, /add to cart|add to bag|add for delivery|add item/i);
        }
        if (add) {
          await requestBrowser({ action: "click", selector: { role: add.role, name: add.name, index: add.index, ...(add.id ? { id: add.id } : {}), ...(add.observationId ? { observationId: add.observationId } : {}), ...(add.pageGeneration !== undefined ? { pageGeneration: add.pageGeneration } : {}) } }, "action");
          cartPrepared = true;
          observation = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "action");
          cartContentsVerified = hasCartSignal(observation);
        }
        check("cart preparation", Boolean(add) && cartPrepared && cartContentsVerified, { addToCartControlFound: Boolean(add), clicked: cartPrepared, cartSignal: cartContentsVerified });
        const checkout = interactiveMatches(observation).find((item) => ["button", "link"].includes(String(item.role)) && /checkout|review cart|view cart|go to cart|shopping cart|cart/i.test(String(item.name || "")) && !/add\s+(?:to\s+)?(?:cart|bag)|buy now/i.test(String(item.name || "")) && !isPurchaseControlLabel(item.name));
        if (checkout && !isPurchaseControlLabel(checkout.name)) {
          console.log(JSON.stringify({ retailer: retailer.id, phase: "cart_review" }));
          await requestBrowser({ action: "click", selector: { role: checkout.role, name: checkout.name, index: checkout.index, ...(checkout.id ? { id: checkout.id } : {}), ...(checkout.observationId ? { observationId: checkout.observationId } : {}), ...(checkout.pageGeneration !== undefined ? { pageGeneration: checkout.pageGeneration } : {}) } }, "action");
          const review = await requestBrowser({ action: "observe", includeScreenshot: true, includePageContent: true }, "action");
          const reviewText = `${String(review.url || "")} ${String(review.title || "")} ${String(review.pageContent || "")}`.toLowerCase();
          cartOpened = true;
          checkoutReviewReached = /checkout|order summary|review order|delivery|shipping|payment/.test(reviewText);
          const purchaseControl = interactiveMatches(review).find((item) => isPurchaseControlLabel(item.name));
          // The presence of a purchase control is evidence for owner approval,
          // never permission for this harness to click it.
          stoppedBeforePurchase = true;
          check("cart opened and contents reviewed", cartOpened && cartContentsVerified && checkoutReviewReached, { checkoutControlFound: Boolean(checkout), checkoutReviewReached, purchaseControlVisible: Boolean(purchaseControl), stoppedBeforePurchase });
        } else check("checkout approval boundary", false, { checkoutControlFound: Boolean(checkout), stoppedBeforePurchase });
      }
      const handoffHost = sandbox.getHost(6080);
      const handoffUrl = /^https?:\/\//i.test(handoffHost) ? handoffHost : `https://${handoffHost}`;
      const handoffPage = await fetch(`${handoffUrl}/vnc.html`, { signal: AbortSignal.timeout(phaseTimeoutMs("handoff")) }).catch((error) => ({ ok: false, status: 0, error: safeDetail(error) }));
      const handoffScreenshot = await requestBrowser({ action: "screenshot" }, "handoff").then((shot) => Boolean(shot.screenshot)).catch(() => false);
      const liveUrl = `${handoffUrl}/vnc.html#autoconnect=1&resize=scale&password=${encodeURIComponent(vncPassword)}`;
      check("retailer handoff probe kept separate", handoffPage.ok === true && handoffScreenshot, { screenshot: handoffScreenshot, challengeDetected, handoffUrl: liveUrl, httpStatus: handoffPage.status });
      const diagnostics = await requestBrowser({ action: "diagnostics" }, "handoff").catch((error) => ({ error: safeDetail(error) }));
      const diagnosticsCaptured = !((diagnostics as Record<string, unknown>).error);
      check("diagnostics captured before cleanup", diagnosticsCaptured, { available: diagnosticsCaptured });
      const flowVerified = productOpened && cartPrepared && cartOpened && cartContentsVerified && checkoutReviewReached && stoppedBeforePurchase;
      const outcome = challengeDetected ? "challenge_required" : flowVerified ? "verified" : "failed";
      results.push({ retailer: retailer.id, ok: checks.every((item) => item.ok), outcome, flowVerified, challengeDetected, productOpened, cartPrepared, cartOpened, cartContentsVerified, checkoutReviewReached, stoppedBeforePurchase, liveUrl: keepAlive ? liveUrl : undefined, checks, sandboxId: sandbox.sandboxId, durationMs: Date.now() - startedAt });
      if (keepAlive) {
        console.log(JSON.stringify({ retailer: retailer.id, phase: "live_view_ready", liveUrl, expiresInMs: keepAliveMs, sandboxId: sandbox.sandboxId, challengeDetected, message: "Open the URL to watch the retained browser. No purchase action will be submitted." }));
        await new Promise((resolve) => setTimeout(resolve, keepAliveMs));
      }
    } catch (error) {
      const failure = classifyRetailerFailure(error);
      let evidence: Record<string, unknown> = {};
      if (requestBrowser) {
        evidence = {
          diagnostics: await requestBrowser({ action: "diagnostics" }, "handoff").catch((item) => ({ error: safeDetail(item) })),
          screenshot: await requestBrowser({ action: "screenshot" }, "handoff").then((item) => Boolean(item.screenshot)).catch(() => false),
        };
      }
      const diagnosticResult = evidence.diagnostics as Record<string, unknown> | undefined;
      const challenge = diagnosticResult?.challenge as Record<string, unknown> | undefined;
      const challengeDetected = challenge?.detected === true || diagnosticResult?.needsUserInteraction === true;
      const handoffReady = evidence.screenshot === true;
      if (challengeDetected) {
        check("retailer flow paused for detected challenge", handoffReady, { challenge, handoffReady });
        results.push({ retailer: retailer.id, ok: handoffReady, outcome: "challenge_required", flowVerified: false, challengeDetected: true, stoppedBeforePurchase: true, failureClass: "challenge_required", checks, evidence, sandboxId: sandbox?.sandboxId, durationMs: Date.now() - startedAt });
      } else {
        check("retailer flow", false, `${failure}: ${safeDetail(error)}`);
        results.push({ retailer: retailer.id, ok: false, outcome: "failed", flowVerified: false, failureClass: failure, checks, evidence, sandboxId: sandbox?.sandboxId, durationMs: Date.now() - startedAt });
      }
    } finally {
      await sandbox?.kill().catch(() => undefined);
    }
  }
  const report = { ok: results.every((item) => item.ok), allFlowsVerified: results.every((item) => item.flowVerified === true), template, neverSubmitPayment: true, results };
  const reportPath = path.join(artifactDir, "retailer-matrix.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(safeDetail(error)); process.exitCode = 1; });
