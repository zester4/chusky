import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chuckTools } from "../src/agentTools.js";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { classifyRetailerFailure, hasCartSignal, isPurchaseControlLabel, pageLooksUsable, phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";

const root = process.cwd();
const templateDockerfile = readFileSync(resolve(root, "e2b", "browser-template", "Dockerfile"), "utf8");
const browserAgent = readFileSync(resolve(root, "e2b", "browser-template", "browser-agent.mjs"), "utf8");
const browserClient = readFileSync(resolve(root, "e2b", "browser-template", "browser-client.mjs"), "utf8");
const browserViewer = readFileSync(resolve(root, "e2b", "browser-template", "chusky-vnc.html"), "utf8");
const browserEngine = readFileSync(resolve(root, "src", "lib", "e2b", "browser.ts"), "utf8");
const browserNetworkPolicy = readFileSync(resolve(root, "src", "lib", "e2b", "networkPolicy.ts"), "utf8");
const liveSmoke = readFileSync(resolve(root, "scripts", "e2b-browser-live-smoke.ts"), "utf8");
const retailerMatrix = readFileSync(resolve(root, "scripts", "e2b-retailer-live-matrix.ts"), "utf8");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
const nativeTools = readFileSync(resolve(root, "src", "nativeTools.ts"), "utf8");

test("E2B browser template installs readable Chromium for the non-root runtime", () => {
  assert.match(templateDockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright/);
  assert.match(templateDockerfile, /playwright install --with-deps chromium/);
  assert.match(templateDockerfile, /chmod -R a\+rX \/opt\/ms-playwright \/app/);
  assert.match(templateDockerfile, /USER chusky/);
});

test("E2B browser agent uses a retained headed Playwright profile and safe Chromium flags", () => {
  assert.match(browserAgent, /const PROFILE = "\/home\/chusky\/\.cache\/chusky-browser"/);
  assert.match(browserAgent, /launchPersistentContext\(PROFILE/);
  assert.match(browserAgent, /--no-sandbox/);
  assert.match(browserAgent, /getByRole/);
  assert.match(browserAgent, /observation_stale/);
  assert.match(browserAgent, /frameFor/);
  assert.match(browserAgent, /healthSnapshot/);
  assert.match(browserAgent, /href: clean/);
  assert.match(browserAgent, /tab_open/);
  assert.match(browserAgent, /page\.keyboard\.type/);
  assert.match(browserAgent, /dragTo/);
  assert.match(browserAgent, /challengeFor/);
  assert.match(browserAgent, /headless: false/);
  assert.match(browserAgent, /const item = await startRecording\(request\.durationSeconds\)/);
  assert.match(browserClient, /127\.0\.0\.1:8765\/command/);
  assert.match(liveSmoke, /browser-agent\.mjs --server/);
  assert.match(liveSmoke, /browser-client\.mjs/);
  assert.match(browserAgent, /screenshot/);
  assert.match(browserAgent, /server\.listen\(8765,\s*"127\.0\.0\.1"\)/);
  assert.match(browserAgent, /safeHttpUrl/);
  assert.match(browserAgent, /Fetch\.enable/);
  assert.match(browserAgent, /Fetch\.requestPaused/);
  assert.match(browserAgent, /createWebBotAuthHeaders/);
  assert.match(browserAgent, /delete browserEnv\.CHUSKY_WEB_BOT_AUTH_PRIVATE_KEY_B64/);
  assert.doesNotMatch(browserAgent, /context\.route/);
  assert.doesNotMatch(browserAgent, /console\.log\([^\n]*(request\.(username|password)|cookie|token)\b/i);
});

test("E2B runtime starts display and browser services through separate idempotent commands", () => {
  assert.ok(browserEngine.includes('const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };'));
  assert.match(browserEngine, /startIfMissing\("mkdir -p \/tmp\/chusky-runtime/);
  assert.match(browserEngine, /startIfMissing\("if \[ ! -f \/tmp\/chusky-xvfb\.pid \]/);
  assert.match(browserEngine, /startIfMissing\("if \[ ! -f \/tmp\/chusky-fluxbox\.pid \]/);
  assert.match(browserEngine, /startIfMissing\("if \[ ! -f \/tmp\/chusky-browser\.pid \]/);
  assert.match(browserEngine, /JSON\.parse\(payload\.body\)\.ok === true/);
  assert.match(browserEngine, /runtimeDiagnostics/);
  assert.doesNotMatch(browserEngine, /process\.exit\(2\)/);
  assert.doesNotMatch(browserEngine, /bash -lc '[^\n]*chusky-xvfb\.pid[^\n]*chusky-fluxbox\.pid[^\n]*chusky-browser\.pid/);
  assert.match(browserEngine, /x11vnc -display :99 -rfbport 5900/);
  assert.match(browserEngine, /const vncPasswordFile = "\/tmp\/chusky-vnc\.passwd"/);
  assert.match(browserEngine, /-passwdfile \$\{vncPasswordFile\}/);
  assert.match(browserEngine, /CHUSKY_VNC_PASSWORD/);
  assert.doesNotMatch(browserEngine, /-passwd \$\{token\}/);
  assert.match(browserEngine, /tail -n 12 \/tmp\/chusky-x11vnc\.log/);
  assert.match(browserEngine, /websockify --web=\/usr\/share\/novnc \$\{BROWSER_STREAM_PORT\} localhost:5900/);
  assert.match(liveSmoke, /-passwdfile \$\{vncPasswordFile\}/);
  assert.doesNotMatch(liveSmoke, /-passwd \$\{vncPassword\}/);
  assert.match(browserEngine, /chusky-vnc\.html#autoconnect=1&resize=scale&password=/);
  assert.doesNotMatch(browserEngine, /vnc\.html\?autoconnect=1&resize=scale&password=/);
  assert.match(browserEngine, /BROWSER_STREAM_PORT.*vnc\.html/);
  assert.doesNotMatch(browserEngine, /pkill -f \\"x11vnc\.\*-rfbport 5900/);
});

test("E2B template includes the desktop handoff dependencies", () => {
  assert.match(templateDockerfile, /xvfb fluxbox x11vnc novnc/);
  assert.match(templateDockerfile, /dpkg-query -W novnc \| cut -f2/);
  assert.match(templateDockerfile, /\/usr\/share\/novnc\/package\.json/);
  assert.match(templateDockerfile, /COPY browser-agent\.mjs browser-client\.mjs web-bot-auth\.mjs \.\//);
  assert.match(templateDockerfile, /COPY chusky-vnc\.html \/usr\/share\/novnc\/chusky-vnc\.html/);
  assert.match(templateDockerfile, /npm ci --omit=dev/);
});

test("E2B handoff viewer uses the Chusky theme while embedding noVNC", () => {
  assert.match(browserViewer, /Chusky/);
  assert.match(browserViewer, /--primary:\s*#e05d38/);
  assert.match(browserViewer, /iframe/);
  assert.match(browserViewer, /\/vnc\.html/);
  assert.match(browserViewer, /Private browser session/);
});

test("E2B browser exposes an owner-only live stream for the retained Chromium display", () => {
  assert.match(browserEngine, /stream_start/);
  assert.match(browserEngine, /stream_status/);
  assert.match(browserEngine, /stream_stop/);
  assert.match(browserEngine, /noVNC/);
  assert.match(browserEngine, /stream: \{ startedAt: stream\.startedAt, expiresAt: stream\.expiresAt, port: stream\.port \}/);
  assert.match(browserEngine, /Live browser streams are available only in the owner's private conversation/);
  assert.ok(chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER")?.function.parameters.properties.action.enum.includes("stream_start"));
});

test("E2B browser configuration is opt-in and exposes the backend-neutral browser slug", () => {
  assert.match(envExample, /E2B_ENABLED=false/);
  assert.match(envExample, /E2B_API_KEY=/);
  assert.match(envExample, /E2B_BROWSER_TEMPLATE=chusky-browser-playwright/);
  assert.match(envExample, /E2B_ALLOW_INTERNET=true/);
  assert.match(envExample, /E2B_AUTO_PAUSE=true/);
  assert.match(envExample, /E2B_BROWSER_LOCALE=en-GB/);
  assert.match(envExample, /E2B_BROWSER_TIMEZONE=Europe\/London/);
  assert.match(envExample, /E2B_BROWSER_GEOLOCATION=/);
  assert.ok(chuckTools.some((tool) => tool.function.name === "CHUCK_BROWSER"));
  const browserTool = chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER");
  assert.ok(browserTool);
  assert.match(browserTool.function.description, /browser-pro/);
  assert.match(browserTool.function.description, /retailer-playbook/);
  assert.doesNotMatch(browserTool.function.description, /Daytona browser/i);
});

test("E2B network deny list excludes API-rejected CIDRs and is shared with live smoke", () => {
  assert.match(browserEngine, /denyOut: \[\.\.\.E2B_BROWSER_DENY_OUT_CIDRS\]/);
  assert.match(liveSmoke, /denyOut: \[\.\.\.E2B_BROWSER_DENY_OUT_CIDRS\]/);
  assert.deepEqual([...E2B_BROWSER_DENY_OUT_CIDRS], [
    "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4", "::1/128", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8",
  ]);
  assert.doesNotMatch(browserNetworkPolicy, /"(?:0\.0\.0\.0\/8|::\/128|::ffff:0:0\/96)"/);
});

test("legacy Daytona vault identities cannot hijack configured E2B browser work", () => {
  assert.match(nativeTools, /shouldUseE2BBrowser\(action, config\.e2bEnabled, Boolean\(config\.e2bApiKey\)\)/);
  assert.doesNotMatch(nativeTools, /sessions\.some\(\(session\) => .*workspaceId\.startsWith\("e2b-"\)/);
});

test("retailer live failures are classified and checkout mutations stop at approval", () => {
  assert.equal(classifyRetailerFailure("deadline_exceeded while opening Target"), "timeout");
  assert.equal(classifyRetailerFailure("locator.count: Target page, context or browser has been closed"), "browser_closed");
  assert.equal(classifyRetailerFailure("Cloudflare verify you are human"), "challenge");
  assert.equal(classifyRetailerFailure("locator.click: button not found"), "action_error");
  assert.equal(isPurchaseControlLabel("Place order"), true);
  assert.equal(isPurchaseControlLabel("Proceed to payment"), true);
  assert.equal(isPurchaseControlLabel("Continue to payment"), true);
  assert.equal(isPurchaseControlLabel("Continue to checkout"), false);
  assert.equal(isPurchaseControlLabel("Add to cart"), false);
  assert.equal(pageLooksUsable({ url: "https://shop.example/product/1", title: "Product", pageContent: "Add to cart" }), true);
  assert.equal(pageLooksUsable({ url: "chrome-error://chromewebdata/", title: "", pageContent: "" }), false);
  assert.equal(pageLooksUsable({ url: "https://shop.example/blocked", title: "Robot or human?", pageContent: "" }), false);
  assert.equal(hasCartSignal({ url: "https://shop.example/cart", title: "Your cart", pageContent: "Quantity 1" }), true);
  assert.equal(hasCartSignal({ url: "https://shop.example/product/1", title: "Product", pageContent: "Product details" }), false);
  assert.equal(phaseTimeoutMs("navigation") >= 30_000, true);
  assert.match(retailerMatrix, /checkout approval/i);
  assert.match(retailerMatrix, /never.*(click|submit|place|payment)/i);
  assert.match(retailerMatrix, /allFlowsVerified/);
  assert.match(retailerMatrix, /final order control observed without submission/);
  assert.match(retailerMatrix, /orderReview/);
  assert.match(retailerMatrix, /browser daemon readiness/);
});

test("generic smoke fixture is isolated from retailer navigation", () => {
  assert.match(browserAgent, /const page = await context\.newPage\(\);/);
  assert.match(browserAgent, /runSmokeFixture\(context, pageState\)/);
  assert.match(browserAgent, /page_closed/);
  assert.match(browserAgent, /sameOrigin && \/\(two\[- \]factor/);
});
