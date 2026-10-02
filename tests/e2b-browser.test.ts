import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chuckTools } from "../src/agentTools.js";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";

const root = process.cwd();
const templateDockerfile = readFileSync(resolve(root, "e2b", "browser-template", "Dockerfile"), "utf8");
const browserAgent = readFileSync(resolve(root, "e2b", "browser-template", "browser-agent.mjs"), "utf8");
const browserClient = readFileSync(resolve(root, "e2b", "browser-template", "browser-client.mjs"), "utf8");
const browserEngine = readFileSync(resolve(root, "src", "lib", "e2b", "browser.ts"), "utf8");
const browserNetworkPolicy = readFileSync(resolve(root, "src", "lib", "e2b", "networkPolicy.ts"), "utf8");
const liveSmoke = readFileSync(resolve(root, "scripts", "e2b-browser-live-smoke.ts"), "utf8");
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
  assert.match(browserEngine, /websockify --web=\/usr\/share\/novnc 6080 localhost:5900/);
  assert.match(browserEngine, /vnc\.html#autoconnect=1&resize=scale&password=/);
  assert.doesNotMatch(browserEngine, /vnc\.html\?autoconnect=1&resize=scale&password=/);
  assert.match(browserEngine, /127\.0\.0\.1:6080\/vnc\.html/);
  assert.doesNotMatch(browserEngine, /pkill -f \\"x11vnc\.\*-rfbport 5900/);
});

test("E2B template includes the desktop handoff dependencies", () => {
  assert.match(templateDockerfile, /xvfb fluxbox x11vnc novnc/);
  assert.match(templateDockerfile, /dpkg-query -W novnc \| cut -f2/);
  assert.match(templateDockerfile, /\/usr\/share\/novnc\/package\.json/);
  assert.match(templateDockerfile, /COPY browser-agent\.mjs browser-client\.mjs web-bot-auth\.mjs/);
  assert.match(templateDockerfile, /npm ci --omit=dev/);
});

test("E2B browser configuration is opt-in and exposes the backend-neutral browser slug", () => {
  assert.match(envExample, /E2B_ENABLED=false/);
  assert.match(envExample, /E2B_API_KEY=/);
  assert.match(envExample, /E2B_BROWSER_TEMPLATE=chusky-browser-playwright/);
  assert.match(envExample, /E2B_ALLOW_INTERNET=true/);
  assert.ok(chuckTools.some((tool) => tool.function.name === "CHUCK_BROWSER"));
  const browserTool = chuckTools.find((tool) => tool.function.name === "CHUCK_BROWSER");
  assert.ok(browserTool);
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
