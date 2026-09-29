import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
if (!apiKey) throw new Error("E2B_API_KEY is required");

async function main() {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: 300_000,
      requestTimeoutMs: 120_000,
      allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
      network: { allowPublicTraffic: true },
      metadata: { app: "chusky", purpose: "disposable-browser-integration-smoke" },
    });
    const run = async (label: string, command: string, options: Record<string, unknown> = {}) => {
      try { return await sandbox.commands.run(command, options as never); }
      catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    await run("runtime directory", "mkdir -p /tmp/chusky-runtime /tmp/chusky-browser-upload && chmod 700 /tmp/chusky-runtime /tmp/chusky-browser-upload");
    await run("Xvfb", "Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("Fluxbox", "fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("browser daemon", "node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...displayEnv, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const requestBrowser = async (request: Record<string, unknown>) => {
      const result = await run("browser client", "node /app/browser-client.mjs", {
        cwd: "/app",
        envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url") },
        timeoutMs: 60_000,
        requestTimeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        const diagnostics = await sandbox.commands.run("tail -100 /tmp/chusky-browser-agent.log 2>/dev/null || true").catch(() => ({ stdout: "" }));
        throw new Error([result.stderr, result.stdout, diagnostics.stdout].filter(Boolean).join("\n").slice(0, 4_000));
      }
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}") as Record<string, any>;
      if (parsed.ok !== true) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 500)}`);
      return parsed;
    };
    const assertCheck = (name: string, condition: boolean, detail?: string) => {
      checks.push({ name, ok: condition, ...(detail ? { detail } : {}) });
      if (!condition) throw new Error(`Smoke check failed: ${name}${detail ? ` (${detail})` : ""}`);
    };

    const publicUrl = process.argv[2] || "https://www.iana.org/help/example-domains";
    const opened = await requestBrowser({ action: "open", url: publicUrl });
    const publicSnapshot = await requestBrowser({ action: "snapshot", includePageContent: true });
    assertCheck("public internet navigation and readable page content", typeof opened.url === "string" && publicSnapshot.pageContent?.length > 80, String(opened.url));

    const fixture = await requestBrowser({ action: "smoke_fixture" });
    assertCheck("private smoke fixture content", String(fixture.pageContent).includes("Visible content proves page reading works."));
    const textbox = (fixture.matches as Array<any>).find((item) => item.role === "textbox" && item.name === "Search fixture");
    const button = (fixture.matches as Array<any>).find((item) => item.role === "button" && item.name === "Continue");
    if (!textbox || !button) throw new Error("Smoke fixture did not expose its accessible text field and button");
    await requestBrowser({ action: "fill", selector: { role: textbox.role, name: textbox.name, index: textbox.index }, value: "E2B form test" });
    await requestBrowser({ action: "click", selector: { role: button.role, name: button.name, index: button.index } });
    const submitted = await requestBrowser({ action: "snapshot", includePageContent: true });
    assertCheck("accessible form fill and button action", String(submitted.pageContent).includes("Submitted: E2B form test"));
    await requestBrowser({ action: "scroll", direction: "down", amount: 3 });

    const uploadInput = (submitted.matches as Array<any>).find((item) => item.role === "file" && item.name === "Attach fixture file");
    if (!uploadInput) throw new Error("Smoke fixture did not expose its accessible file input");
    const uploadPath = `/tmp/chusky-browser-upload/${randomUUID()}-fixture.txt`;
    const uploadBytes = Buffer.from("Chusky E2B upload fixture", "utf8");
    await sandbox.files.write(uploadPath, Uint8Array.from(uploadBytes).buffer);
    await requestBrowser({ action: "upload_files", selector: { role: uploadInput.role, name: uploadInput.name, index: uploadInput.index }, uploadPath });
    const uploaded = await requestBrowser({ action: "snapshot", includePageContent: true });
    assertCheck("owner file upload into an inspected file input", String(uploaded.pageContent).includes("Uploaded: ") && String(uploaded.pageContent).includes("fixture.txt"));

    const downloadLink = (uploaded.matches as Array<any>).find((item) => item.role === "link" && item.name === "Download fixture");
    if (!downloadLink) throw new Error("Smoke fixture did not expose its download link");
    await requestBrowser({ action: "click", selector: { role: downloadLink.role, name: downloadLink.name, index: downloadLink.index } });
    const waited = await requestBrowser({ action: "wait_download", timeoutMs: 15_000 });
    if (waited.download?.state !== "ready" || typeof waited.download.id !== "string") throw new Error("Browser did not capture the fixture download");
    const claimed = await requestBrowser({ action: "download_claim", id: waited.download.id });
    if (typeof claimed.filePath !== "string" || !Number.isFinite(claimed.size)) throw new Error("Browser did not expose the bounded fixture download to the trusted adapter");
    const downloaded = Buffer.from(await sandbox.files.read(claimed.filePath, { format: "bytes" }));
    assertCheck("download capture and byte integrity", downloaded.toString("utf8") === "Chusky E2B download fixture");
    await requestBrowser({ action: "download_ack", id: waited.download.id });

    const login = await requestBrowser({ action: "vault_login", smokeFixture: true, url: "https://vault-smoke.invalid/login", usernameFieldLabel: "Email", passwordFieldLabel: "Password", submitButtonLabel: "Sign in", username: "smoke-user@example.invalid", password: "not-a-real-password" });
    const loginState = {
      authenticated: login.authenticated === true,
      needsUserInteraction: login.needsUserInteraction === true,
      loginUnverified: login.loginUnverified === true,
      loginState: typeof login.loginState === "string" ? login.loginState : undefined,
      challengeType: typeof login.challenge?.type === "string" ? login.challenge.type : undefined,
      title: typeof login.title === "string" ? login.title.slice(0, 100) : undefined,
      origin: typeof login.url === "string" ? (() => { try { return new URL(login.url).origin; } catch { return "invalid"; } })() : undefined,
    };
    assertCheck("vault login state machine on a controlled login form", login.authenticated === true && login.needsUserInteraction !== true, JSON.stringify(loginState));
    const loginJson = JSON.stringify(login);
    assertCheck("vault login output does not contain test credentials", !loginJson.includes("smoke-user@example.invalid") && !loginJson.includes("not-a-real-password"));

    const started = await requestBrowser({ action: "recording_start", durationSeconds: 10 });
    if (!started.recording?.id) throw new Error("Browser recording did not start");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stopped = await requestBrowser({ action: "recording_stop", recordingId: started.recording.id });
    const recordingPath = stopped.runtimeFilePath;
    if (!recordingPath || !Number.isFinite(stopped.recording?.size)) throw new Error("Browser recording did not produce a file");
    const recordingBytes = Buffer.from(await sandbox.files.read(recordingPath, { format: "bytes" }));
    assertCheck("screen recording capture and file integrity", recordingBytes.length === stopped.recording.size && recordingBytes.length > 1_000 && recordingBytes.subarray(4, 8).toString("ascii") === "ftyp");
    await requestBrowser({ action: "recording_ack", id: started.recording.id });

    const screenshot = await requestBrowser({ action: "screenshot" });
    const screenshotBytes = typeof screenshot.screenshot === "string" ? Buffer.from(screenshot.screenshot, "base64") : Buffer.alloc(0);
    assertCheck("real Chromium screenshot", screenshotBytes.length > 2_000 && screenshotBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));

    const vncPassword = randomUUID().replaceAll("-", "").slice(0, 8);
    await run("x11vnc handoff service", `x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwd ${vncPassword} >/tmp/chusky-x11vnc-smoke.log 2>&1`, { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("noVNC handoff service", "websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/chusky-websockify-smoke.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    let previewReady = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = await sandbox.commands.run("node -e \"fetch('http://127.0.0.1:6080/vnc.html').then(async r=>{console.log(r.ok?'ready':'not-ready');await r.arrayBuffer()}).catch(()=>console.log('not-ready'))\"", { timeoutMs: 3_000, envs: displayEnv });
      if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).at(-1) === "ready") { previewReady = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assertCheck("same-sandbox human handoff service is listening", previewReady);
    const handoffHost = sandbox.getHost(6080);
    const handoffUrl = /^https?:\/\//i.test(handoffHost) ? handoffHost : `https://${handoffHost}`;
    const handoffPage = await fetch(`${handoffUrl}/vnc.html`, { signal: AbortSignal.timeout(15_000) });
    assertCheck("E2B preview link reaches the live noVNC handoff page", handoffPage.ok, `HTTP ${handoffPage.status}`);
    const handoffProbe = `import { chromium } from "playwright";
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  let framesReceived = 0;
  let framesSent = 0;
  const websocketEvents = [];
  const failedRequests = [];
  const pageErrors = [];
  const badResponses = [];
  const consoleMessages = [];
  const requestedUrls = [];
  const successfulAssets = [];
  page.on("websocket", (socket) => { websocketEvents.push("created"); socket.on("framereceived", () => { framesReceived += 1; }); socket.on("framesent", () => { framesSent += 1; }); socket.on("close", () => websocketEvents.push("close")); socket.on("socketerror", (error) => websocketEvents.push("error:" + String(error).slice(0, 120))); });
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 200)));
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text().slice(0, 200) }));
  page.on("request", (request) => { try { const url = new URL(request.url()); requestedUrls.push(url.origin + url.pathname); } catch {} });
  page.on("response", (response) => { try { const url = new URL(response.url()); const item = { status: response.status(), url: url.origin + url.pathname }; if (response.status() >= 400) badResponses.push(item); else if (url.pathname.endsWith(".js") || url.pathname.endsWith(".json")) successfulAssets.push(item); } catch {} });
  page.on("requestfailed", (request) => { try { const url = new URL(request.url()); failedRequests.push(url.origin + url.pathname); } catch {} });
  const response = await page.goto(${JSON.stringify(handoffUrl + "/vnc.html#autoconnect=1&resize=scale&password=" + vncPassword)}, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.classList.contains("noVNC_connected"), { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
  const status = await page.locator("#noVNC_status").innerText().catch(() => "");
  const canvas = await page.locator("#noVNC_canvas").count().catch(() => 0);
  const canvasAny = await page.locator("canvas").count().catch(() => 0);
  const body = await page.locator("body").innerText().catch(() => "");
  const uiState = await page.evaluate(() => ({ rootClass: document.documentElement.className, connectDialogClass: document.getElementById("noVNC_connect_dlg")?.className ?? null, statusClass: document.getElementById("noVNC_status")?.className ?? null, canvases: Array.from(document.querySelectorAll("canvas")).map((item) => ({ width: item.width, height: item.height, visible: item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0 })), scripts: Array.from(document.scripts).map((script) => script.src).filter(Boolean) })).catch(() => null);
  const packageManifestValid = await page.evaluate(async () => { try { const response = await fetch("./package.json"); if (!response.ok) return false; const manifest = await response.json(); return typeof manifest?.version === "string" && manifest.version.length > 0; } catch { return false; } }).catch(() => false);
  const connected = Boolean(uiState?.rootClass?.split(/\\s+/).includes("noVNC_connected")) && framesReceived > 0 && canvasAny > 0 && Boolean(uiState?.canvases?.some((item) => item.width > 0 && item.height > 0));
  console.log(JSON.stringify({ httpStatus: response?.status(), title: await page.title().catch(() => ""), framesReceived, framesSent, websocketEvents, connected, packageManifestValid, canvasPresent: canvas > 0, canvasCount: canvasAny, status: String(status).slice(0, 100), body: String(body).slice(0, 250), uiState, failedRequests: failedRequests.slice(0, 10), badResponses: badResponses.slice(0, 10), successfulAssets: successfulAssets.slice(0, 16), requestedUrls: requestedUrls.slice(0, 20), consoleMessages: consoleMessages.slice(0, 12), pageErrors: pageErrors.slice(0, 5) }));
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/password=[^&\\s]+/gi, "password=[redacted]").slice(0, 300) : "viewer probe failed";
  console.log(JSON.stringify({ connected: false, error: message }));
} finally { await browser?.close(); }
`;
    await sandbox.files.write("/app/e2b-handoff-probe.mjs", Uint8Array.from(Buffer.from(handoffProbe)).buffer);
    const viewerProbe = await run("private handoff browser probe", "node /app/e2b-handoff-probe.mjs", { cwd: "/app", envs: { ...displayEnv, PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright" }, timeoutMs: 35_000, requestTimeoutMs: 45_000 });
    const viewerResult = JSON.parse(viewerProbe.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
    const handoffLogProbe = await sandbox.commands.run("tail -30 /tmp/chusky-x11vnc-smoke.log /tmp/chusky-websockify-smoke.log 2>/dev/null || true", { timeoutMs: 5_000, envs: displayEnv }).catch(() => ({ stdout: "" }));
    const handoffDiagnostics = { ...viewerResult, logs: String(handoffLogProbe.stdout ?? "").replaceAll(vncPassword, "[redacted]").slice(-1_000) };
    assertCheck("noVNC serves a valid packaged version manifest", viewerResult.packageManifestValid === true);
    assertCheck("noVNC authenticates and connects to the retained Chromium display", viewerProbe.exitCode === 0 && viewerResult.connected === true, JSON.stringify(handoffDiagnostics).slice(0, 4_000));
    const samePage = await requestBrowser({ action: "snapshot", includePageContent: true });
    assertCheck("human handoff leaves the same Playwright page alive", samePage.title === "Chusky vault login fixture" && samePage.url === login.url);

    const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-browser-smoke"));
    await mkdir(artifactDir, { recursive: true });
    const screenshotPath = path.join(artifactDir, "browser.jpg");
    const reportPath = path.join(artifactDir, "report.json");
    await writeFile(screenshotPath, screenshotBytes);
    const report = { ok: checks.every((item) => item.ok), sandboxId: sandbox.sandboxId, template, publicSite: { url: opened.url, title: opened.title, pageContentChars: String(publicSnapshot.pageContent).length }, checks, screenshotPath };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportPath }));
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    checks.push({ name: "smoke execution", ok: false, detail });
    const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-browser-smoke"));
    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, "report.json"), JSON.stringify({ ok: false, template, checks }, null, 2));
    } catch { /* Preserve the original failure in stdout if local report writing fails. */ }
    console.log(JSON.stringify({ ok: false, template, sandboxId: sandbox?.sandboxId, checks }));
    process.exitCode = 1;
  } finally {
    if (sandbox) await sandbox.kill().catch((error) => console.error(`Disposable E2B sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
