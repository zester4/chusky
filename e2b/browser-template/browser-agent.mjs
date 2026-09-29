import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= "/opt/ms-playwright";
const { chromium } = await import("playwright");
const { createWebBotAuthHeaders } = await import("./web-bot-auth.mjs");
import { createPrivateKey, createHash, sign as cryptoSign } from "node:crypto";

const MAX_MATCHES = 60;
const ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "option", "tab", "heading", "listbox", "img", "switch", "file"];
const PROFILE = "/home/chusky/.cache/chusky-browser";
const DISPLAY = process.env.DISPLAY || ":99";
const DOWNLOAD_ROOT = "/tmp/chusky-browser-downloads";
const RECORDING_ROOT = "/tmp/chusky-browser-recordings";
const MAX_PAGE_TEXT = 12_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const clean = (value, max = 180) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const dnsCache = new Map();
const downloaded = new Map();
const downloadWaiters = [];
const recordings = new Map();
const signatureDirectory = process.env.CHUSKY_WEB_BOT_AUTH_DIRECTORY_URL || "";
const signingKeyB64 = process.env.CHUSKY_WEB_BOT_AUTH_PRIVATE_KEY_B64 || "";
let webBotAuthActive = Boolean(signatureDirectory && signingKeyB64);
let webBotAuthSigner;

async function getWebBotAuthSigner() {
  if (webBotAuthSigner) return webBotAuthSigner;
  if (!signatureDirectory || !signingKeyB64) throw new Error("Web Bot Auth key is not configured in this browser sandbox");
  const privateKey = createPrivateKey({ key: Buffer.from(signingKeyB64, "base64"), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Web Bot Auth requires an Ed25519 key");
  const jwk = privateKey.export({ format: "jwk" });
  const keyId = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
  webBotAuthSigner = {
    algorithm: "ed25519",
    keyId,
    sign: (data) => cryptoSign(null, Buffer.from(data), privateKey),
  };
  return webBotAuthSigner;
}

async function interceptPageRequests(context, page) {
  if (page.isClosed() || page.__chuskyFetchInterception) return;
  const cdp = await context.newCDPSession(page);
  page.__chuskyFetchInterception = cdp;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", async (event) => {
    const requestId = event.requestId;
    let url;
    try { url = new URL(event.request.url); } catch {
      await cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      await cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
      return;
    }
    try {
      await safeHttpUrl(url.toString(), true);
    } catch {
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
      return;
    }

    const originalHeaders = Object.entries(event.request.headers || {})
      .filter(([name]) => !["signature", "signature-input", "signature-agent"].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) }));
    if (!webBotAuthActive || url.protocol !== "https:") {
      await cdp.send("Fetch.continueRequest", { requestId, headers: originalHeaders }).catch(() => {});
      return;
    }
    try {
      const headers = await createWebBotAuthHeaders({
        url: url.toString(),
        method: event.request.method,
        headers: originalHeaders,
      }, {
        ...await getWebBotAuthSigner(),
        directoryUrl: signatureDirectory,
      });
      await cdp.send("Fetch.continueRequest", {
        requestId,
        headers,
      });
    } catch {
      // Do not silently send unsigned requests when identity signing is enabled.
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
}

function safeFileName(value) {
  const name = path.basename(String(value ?? "").replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().slice(0, 120);
  return name && name !== "." && name !== ".." ? name : "browser-download.bin";
}

function notifyDownload(item) {
  const waiter = downloadWaiters.shift();
  if (waiter) waiter(item);
}

async function pageText(page) {
  const raw = await page.locator("body").evaluate((element, max) => {
    const text = element.innerText || "";
    return { text: text.slice(0, max + 1), truncated: text.length > max };
  }, MAX_PAGE_TEXT).catch(() => ({ text: "", truncated: false }));
  return { pageContent: clean(raw.text, MAX_PAGE_TEXT), pageContentTruncated: raw.truncated || raw.text.length > MAX_PAGE_TEXT };
}

function privateAddress(value) {
  const kind = net.isIP(value);
  if (kind === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const normalized = value.toLowerCase();
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || Boolean(mapped && privateAddress(mapped[1]));
  }
  return true;
}

async function safeHttpUrl(value, resolveDns = true) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("Only public http(s) URLs are allowed"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only public http(s) URLs are allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (["localhost", "metadata", "metadata.google.internal"].includes(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || (net.isIP(host) && privateAddress(host))) throw new Error("Private or local browser navigation is blocked");
  if (resolveDns && !net.isIP(host)) {
    const cached = dnsCache.get(host);
    const addresses = cached && cached.expiresAt > Date.now() ? cached.addresses : (await dns.lookup(host, { all: true, verbatim: true })).map((item) => item.address);
    if (!addresses.length || addresses.some(privateAddress)) throw new Error("Browser navigation resolved to a private address");
    dnsCache.set(host, { addresses, expiresAt: Date.now() + 60_000 });
  }
  return url;
}

function nameMatcher(value) {
  if (value?.nameMatch === "regex") {
    try { return new RegExp(String(value?.name || "").slice(0, 160), "i"); } catch { return String(value?.name || ""); }
  }
  return String(value?.name || "");
}

function locatorFor(page, value) {
  const role = typeof value?.role === "string" && ROLES.includes(value.role) ? value.role : "button";
  const name = nameMatcher(value);
  if (role === "file") return page.locator('input[type="file"]').nth(Math.max(0, Number(value?.index ?? 0)));
  const options = name ? { name, exact: value?.nameMatch !== "substring" && value?.nameMatch !== "regex" } : {};
  return page.getByRole(role, options).nth(Math.max(0, Number(value?.index ?? 0)));
}

async function roleMatches(page, request = {}) {
  const requestedRole = typeof request.role === "string" && ROLES.includes(request.role) ? request.role : undefined;
  const roles = requestedRole ? [requestedRole] : ROLES;
  const out = [];
  const name = request.name ? nameMatcher(request) : undefined;
  const options = name ? { name, exact: request.nameMatch !== "substring" && request.nameMatch !== "regex" } : {};
  const limit = Math.max(1, Math.min(MAX_MATCHES, Number(request.limit ?? MAX_MATCHES)));
  for (const role of roles) {
    const locator = role === "file" ? page.locator('input[type="file"]') : page.getByRole(role, options);
    const count = Math.min(await locator.count(), limit - out.length);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (role !== "file" && !(await item.isVisible().catch(() => false))) continue;
      const label = await item.getAttribute("aria-label").catch(() => "");
      const alt = await item.getAttribute("alt").catch(() => "");
      const associated = role === "file" ? await item.evaluate((element) => {
        const input = element;
        const labels = Array.from(input.labels || []).map((label) => label.innerText || label.textContent || "");
        return labels.join(" ") || input.getAttribute("title") || input.getAttribute("name") || input.getAttribute("accept") || "File upload";
      }).catch(() => "File upload") : "";
      const nameValue = clean(label || await item.innerText().catch(() => "") || alt || associated);
      if (name && !String(nameValue).toLowerCase().includes(String(name).toLowerCase())) continue;
      if (nameValue) out.push({ role, name: nameValue, index, ...(role === "link" ? { href: clean(await item.getAttribute("href").catch(() => ""), 1_000) } : {}) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function challengeFor(page) {
  const url = page.url().toLowerCase();
  const title = clean(await page.title().catch(() => ""), 200).toLowerCase();
  const text = clean(await page.locator("body").innerText().catch(() => ""), 4_000).toLowerCase();
  const source = `${url} ${title} ${text}`;
  const captcha = /(captcha|recaptcha|hcaptcha|cloudflare.*verify|verify you are human|checking your browser)/.test(source);
  const twoFactor = /(two[- ]factor|2fa|one[- ]time password|one[- ]time code|verification code|security code|authenticator app|security key|passkey|approve sign[- ]in|magic link)/.test(source);
  if (!captcha && !twoFactor) return { detected: false };
  return { detected: true, type: captcha ? "captcha" : "two_factor" };
}

async function tabsFor(context, active) {
  return Promise.all(context.pages().slice(0, 10).map(async (page, index) => ({ index, url: page.url(), title: clean(await page.title().catch(() => ""), 160), active: page === active })));
}

async function linkPayTokenFrame(page) {
  for (const frame of page.frames()) {
    try {
      const input = frame.locator('input[name="link_pay_token"]').first();
      const inputCount = await frame.locator('input[name="link_pay_token"]').count();
      const account = frame.locator('[data-stripe-merchant-account^="acct_"]').first();
      const accountCount = await frame.locator('[data-stripe-merchant-account^="acct_"]').count();
      if (inputCount > 0 && accountCount > 0) {
        const merchantAccountId = await account.getAttribute("data-stripe-merchant-account");
        if (merchantAccountId && /^acct_[A-Za-z0-9]+$/.test(merchantAccountId)) return { frame, input, merchantAccountId, frameUrl: frame.url() };
      }
    } catch {
      // A third-party frame can disappear while the checkout is navigating.
    }
  }
  return undefined;
}

async function result(page, context, extra = {}, includePageContent = false) {
  const challenge = await challengeFor(page);
  return { ok: true, url: page.url(), title: clean(await page.title().catch(() => ""), 160), loadState: "settled", ...(challenge.detected ? { needsUserInteraction: true, challenge } : { challenge }), ...(includePageContent ? await pageText(page) : {}), ...extra, tabs: await tabsFor(context, page), activeIndex: context.pages().indexOf(page) };
}

async function runSmokeFixture(context) {
  const page = context.pages()[0] || await context.newPage();
  await page.setContent(`<!doctype html><html><head><title>Chusky E2B browser fixture</title></head><body>
    <main><h1>Browser integration fixture</h1><p>Visible content proves page reading works.</p>
    <label for="query">Search fixture</label><input id="query" aria-label="Search fixture" />
    <button id="continue">Continue</button><output id="output"></output>
    <label for="upload">Attach fixture file</label><input id="upload" type="file" aria-label="Attach fixture file" />
    <a id="download" download="fixture.txt" href="data:text/plain;base64,Q2h1c2t5IEUyQiBkb3dubG9hZCBmaXh0dXJl">Download fixture</a>
    <div style="height:2400px">End of long page</div></main>
    <script>
      document.querySelector('#continue').addEventListener('click',()=>{document.querySelector('#output').textContent='Submitted: '+document.querySelector('#query').value});
      document.querySelector('#upload').addEventListener('change',(event)=>{document.querySelector('#output').textContent+='; Uploaded: '+(event.target.files?.[0]?.name||'none')});
    </script>
  </body></html>`);
  return result(page, context, { matches: await roleMatches(page) }, true);
}

async function waitForDownload(timeoutMs) {
  const ready = [...downloaded.values()].find((item) => item.state === "ready");
  if (ready) return ready;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (item) => { if (settled) return; settled = true; clearTimeout(timer); resolve(item); };
    const timer = setTimeout(() => finish(null), Math.max(100, Math.min(30_000, timeoutMs)));
    downloadWaiters.push(finish);
  });
}

function attachDownloadListener(page) {
  page.on("download", (download) => {
    const id = "dl_" + randomUUID();
    const name = safeFileName(download.suggestedFilename());
    const filePath = path.join(DOWNLOAD_ROOT, id + "-" + name);
    const item = { id, name, filePath, state: "saving", createdAt: Date.now(), size: 0 };
    downloaded.set(id, item);
    void (async () => {
      try {
        await fs.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
        await download.saveAs(filePath);
        const info = await fs.stat(filePath);
        if (!info.isFile() || info.size < 1 || info.size > MAX_DOWNLOAD_BYTES) throw new Error("download size is outside the supported limit");
        item.size = info.size;
        item.state = "ready";
        notifyDownload(item);
      } catch (error) {
        item.state = "failed";
        item.error = clean(error?.message || error, 200);
        await fs.rm(filePath, { force: true }).catch(() => {});
        notifyDownload(item);
      }
    })();
  });
}

function waitForProcessClose(item, timeoutMs) {
  if (item.exitCode !== null || item.exitSignal !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timer);
      item.process.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    item.process.once("close", onClose);
  });
}

async function startRecording(durationSeconds = 900) {
  const active = [...recordings.values()].filter((item) => item.state === "recording").length;
  if (active >= 2) throw new Error("At most two browser recordings can run at once");
  const id = "rec_" + randomUUID();
  const filePath = path.join(RECORDING_ROOT, id + ".mp4");
  const boundedDuration = Math.max(10, Math.min(900, Number(durationSeconds) || 900));
  const process = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-nostdin", "-f", "x11grab", "-video_size", "1440x900", "-framerate", "8", "-i", DISPLAY, "-t", String(boundedDuration), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-movflags", "+faststart", filePath], { stdio: ["ignore", "ignore", "pipe"] });
  const item = { id, name: id + ".mp4", filePath, state: "recording", createdAt: Date.now(), size: 0, process, exitCode: null, exitSignal: null, stderr: "" };
  process.stderr?.on("data", (chunk) => { item.stderr = (item.stderr + String(chunk)).slice(-1_200); });
  recordings.set(id, item);
  process.once("error", (error) => { item.state = "failed"; item.error = clean(error.message, 200); });
  process.once("close", (code, signal) => {
    item.exitCode = code;
    item.exitSignal = signal;
    if (item.state === "recording" || item.state === "stopping") item.state = code === 0 || code === 255 ? "ready" : "failed";
  });
  const readyBy = Date.now() + 5_000;
  while (Date.now() < readyBy) {
    if (item.state === "failed" || item.exitCode !== null || item.exitSignal !== null) break;
    const info = await fs.stat(filePath).catch(() => null);
    if (info?.isFile() && info.size > 0) return item;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (item.state === "recording" && item.exitCode === null && item.exitSignal === null) {
    item.process.kill("SIGTERM");
    if (!(await waitForProcessClose(item, 1_500))) {
      item.process.kill("SIGKILL");
      await waitForProcessClose(item, 1_000);
    }
  }
  const startupDetail = item.error || item.stderr || "ffmpeg did not produce video frames during startup";
  item.state = "failed";
  recordings.delete(id);
  await fs.rm(filePath, { force: true });
  throw new Error(`Recording failed to start (${clean(startupDetail, 300)})`);
}

async function stopRecording(id) {
  const item = recordings.get(String(id));
  if (!item) throw new Error("Recording not found");
  if (item.state === "recording") {
    item.state = "stopping";
    item.process.kill("SIGINT");
    if (!(await waitForProcessClose(item, 8_000))) {
      item.process.kill("SIGTERM");
      if (!(await waitForProcessClose(item, 2_000))) {
        item.process.kill("SIGKILL");
        await waitForProcessClose(item, 1_000);
      }
    }
  }
  const info = await fs.stat(item.filePath).catch(() => null);
  if (!info?.isFile() || info.size < 1 || info.size > 100 * 1024 * 1024) {
    item.state = "failed";
    const processState = item.exitCode === null ? "still running" : `exit ${item.exitCode}${item.exitSignal ? ` (${item.exitSignal})` : ""}`;
    const detail = item.error || item.stderr || `ffmpeg ${processState}`;
    if (item.exitCode !== null || item.exitSignal !== null) item.state = "failed";
    throw new Error(`Recording did not produce a supported video file (${clean(detail, 300)})`);
  }
  const handle = await fs.open(item.filePath, "r");
  const header = Buffer.alloc(12);
  let bytesRead = 0;
  try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)); }
  finally { await handle.close(); }
  if (bytesRead < 12 || header.toString("ascii", 4, 8) !== "ftyp") {
    item.state = "failed";
    throw new Error("Recording did not produce a valid MP4 container");
  }
  item.size = info.size;
  item.state = "ready";
  return item;
}

async function runtimeFileList(kind) {
  const records = kind === "recording" ? [...recordings.values()] : [...downloaded.values()];
  return records.slice(-50).map((item) => ({ id: item.id, name: item.name, state: item.state, size: item.size, createdAt: item.createdAt, ...(item.error ? { error: item.error } : {}) }));
}

async function execute(context, pageState, request) {
  let page = context.pages()[Math.max(0, Math.min(9, Number(pageState.activeIndex ?? 0)))] || context.pages()[0] || await context.newPage();
  if (request.action === "tab_open") page = await context.newPage();
  if (request.action === "tab_focus") page = context.pages()[Math.max(0, Number(request.index ?? 0))] || page;
  if (request.action === "tab_close") { if (context.pages().length > 1) await page.close(); page = context.pages()[0] || await context.newPage(); }
  if (request.currentUrl && (() => { try { return /^https?:$/.test(new URL(String(request.currentUrl)).protocol); } catch { return false; } })() && (!page.url() || page.url() === "about:blank")) await page.goto((await safeHttpUrl(request.currentUrl)).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  const action = request.action;
  const target = request.selector ? locatorFor(page, request.selector) : null;
  if (action === "open") {
    await page.goto((await safeHttpUrl(request.url)).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  } else if (action === "link_inspect") {
    const match = await linkPayTokenFrame(page);
    return result(page, context, { linkPayToken: match ? { supported: true, merchantAccountId: match.merchantAccountId, frameUrl: clean(match.frameUrl, 1_000) } : { supported: false } });
  } else if (action === "link_pay_token_fill") {
    const match = await linkPayTokenFrame(page);
    if (!match) throw new Error("The current checkout does not expose Link Pay Token markers in one Stripe frame");
    if (request.expectedMerchantAccountId && request.expectedMerchantAccountId !== match.merchantAccountId) throw new Error("The live Stripe merchant account does not match the approved Link Pay Token request");
    if (typeof request.value !== "string" || !request.value || request.value.length > 4096) throw new Error("Link Pay Token value is invalid");
    await match.input.evaluate((element, value) => {
      const input = element;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, request.value);
    return result(page, context, { linkPayToken: { filled: true, merchantAccountId: match.merchantAccountId } });
  } else if (["state", "snapshot", "find"].includes(action)) return result(page, context, { matches: await roleMatches(page, request) }, request.includePageContent === true);
  else if ((action === "click" || action === "move") && Number.isFinite(Number(request.x)) && Number.isFinite(Number(request.y))) {
    if (action === "click") await page.mouse.click(Number(request.x), Number(request.y));
    else await page.mouse.move(Number(request.x), Number(request.y));
  } else if (["invoke", "click", "focus", "fill", "move", "hover", "select_option", "check", "uncheck"].includes(action)) {
    if (!target) throw new Error("This browser action requires a fresh accessible node selector");
    await target.waitFor({ state: "attached", timeout: 10_000 });
    if (["invoke", "click"].includes(action)) await target.click({ timeout: 15_000 });
    if (["move", "hover"].includes(action)) await target.hover({ timeout: 15_000 });
    if (action === "focus") await target.focus();
    if (action === "fill") await target.fill(String(request.value ?? request.text ?? ""));
    if (action === "select_option") await target.selectOption(String(request.value ?? ""));
    if (action === "check") await target.check();
    if (action === "uncheck") await target.uncheck();
  } else if (["upload", "upload_files"].includes(action)) {
    if (!target || !request.uploadPath || !/^\/tmp\/chusky-browser-upload\/[A-Za-z0-9_-]+-[^/]{1,120}$/.test(String(request.uploadPath))) throw new Error("Upload requires a fresh file-input node and an owner file reference");
    if (!(await target.count())) throw new Error("The selected file input is no longer available");
    try {
      if (action === "upload" && request.selector.role !== "file") {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
        await target.click({ timeout: 15_000 });
        const chooser = await chooserPromise;
        await chooser.setFiles(String(request.uploadPath));
      } else {
        await target.setInputFiles(String(request.uploadPath), { timeout: 15_000 });
      }
    } finally {
      await fs.rm(String(request.uploadPath), { force: true }).catch(() => {});
    }
  } else if (action === "type") { if (target) await target.focus(); await page.keyboard.type(String(request.text ?? ""), { delay: Math.max(0, Math.min(250, Number(request.delayMs ?? 0))) }); }
  else if (action === "press") { if (target) await target.focus(); await page.keyboard.press(String(request.key || request.keys || "Enter")); }
  else if (action === "drag") { if (!request.source || !request.target) throw new Error("drag requires source and target accessible selectors"); await locatorFor(page, request.source).dragTo(locatorFor(page, request.target), { timeout: 15_000 }); }
  else if (action === "scroll") await page.mouse.wheel(0, (request.direction === "up" ? -1 : 1) * Math.max(1, Math.min(10, Number(request.amount || 3))) * 600);
  else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "refresh") await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  else if (action === "wait") await page.waitForTimeout(Math.max(50, Math.min(30_000, Number(request.timeoutMs ?? 1_000))));
  else if (["screenshot", "screenshot_full", "screenshot_region", "screenshot_region_full"].includes(action)) {
    const clipped = ["screenshot_region", "screenshot_region_full"].includes(action);
    const clip = clipped && [request.x, request.y, request.width, request.height].every((value) => Number.isFinite(Number(value))) ? { x: Number(request.x), y: Number(request.y), width: Number(request.width), height: Number(request.height) } : undefined;
    const image = await page.screenshot({ type: "jpeg", quality: 75, fullPage: action === "screenshot_full", ...(clip ? { clip } : {}) });
    return result(page, context, { screenshot: image.toString("base64") });
  } else if (action === "downloads" || action === "download_register") {
    return result(page, context, { downloads: await runtimeFileList("download") });
  } else if (action === "wait_download") {
    const item = await waitForDownload(Number(request.timeoutMs ?? 10_000));
    return result(page, context, { download: item ? { id: item.id, name: item.name, state: item.state, size: item.size, createdAt: item.createdAt, ...(item.error ? { error: item.error } : {}) } : null });
  } else if (action === "recording_start") {
    const item = await startRecording(request.durationSeconds);
    return result(page, context, { recording: { id: item.id, name: item.name, state: item.state, createdAt: item.createdAt } });
  } else if (action === "recording_stop") {
    const item = await stopRecording(request.recordingId);
    return result(page, context, { recording: { id: item.id, name: item.name, state: item.state, size: item.size, createdAt: item.createdAt }, runtimeFilePath: item.filePath });
  } else if (action === "recording_list") {
    return result(page, context, { recordings: await runtimeFileList("recording") });
  } else if (action === "recording_get") {
    const item = recordings.get(String(request.recordingId));
    if (!item) throw new Error("Recording not found");
    return result(page, context, { recording: { id: item.id, name: item.name, state: item.state, size: item.size, createdAt: item.createdAt, ...(item.error ? { error: item.error } : {}) } });
  } else if (["tabs", "windows"].includes(action)) return result(page, context);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  return result(page, context, { matches: await roleMatches(page) }, request.includePageContent === true);
}

async function vaultLogin(context, request) {
  const page = context.pages()[0] || await context.newPage();
  if (request.smokeFixture === true && process.env.CHUSKY_E2B_SMOKE_TESTS === "1") {
    await page.setContent(`<!doctype html><html><head><title>Chusky vault login fixture</title></head><body>
      <main><label for="email">Email</label><input id="email" type="email" autocomplete="username" />
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" />
      <button id="login">Sign in</button><button id="logout" hidden>Sign out</button><p id="message"></p></main>
      <script>document.querySelector('#login').addEventListener('click',()=>{document.querySelector('#logout').hidden=false;document.querySelector('#email').hidden=true;document.querySelector('#password').hidden=true;document.querySelector('#message').textContent='Welcome to the test account'});</script>
    </body></html>`);
  } else {
    await page.goto((await safeHttpUrl(request.url)).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  const userNames = [request.usernameFieldLabel, "Email", "Email address", "Email or username", "Username", "Phone number", "Mobile number"].filter(Boolean).map(String);
  const passwordNames = [request.passwordFieldLabel, "Password", "Your password", "Enter password"].filter(Boolean).map(String);
  const buttonNames = [request.submitButtonLabel, "Sign in", "Log in", "Login", "Continue", "Next", "Submit", "Verify"].filter(Boolean).map(String);
  const recipe = request.loginRecipe && typeof request.loginRecipe === "object" ? request.loginRecipe : {};
  const recipeSteps = Array.isArray(recipe.steps) ? recipe.steps.slice(0, 20) : [];
  const visible = async (locator) => await locator.count().catch(() => 0) > 0 && await locator.first().isVisible().catch(() => false);
  const findNamed = async (role, labels) => {
    for (const label of [...new Set(labels)]) {
      const locator = page.getByRole(role, { name: String(label), exact: true }).first();
      if (await visible(locator)) return locator;
      const byLabel = page.getByLabel(String(label), { exact: true }).first();
      if (await visible(byLabel)) return byLabel;
    }
    return null;
  };
  const passwordInput = async () => {
    const direct = page.locator('input[type="password"]:visible').first();
    if (await visible(direct)) return direct;
    return findNamed("textbox", passwordNames);
  };
  const usernameInput = async () => {
    const named = await findNamed("textbox", userNames);
    if (named) return named;
    for (const selector of [
      'input[autocomplete="username"]:visible', 'input[type="email"]:visible',
      'input[name*="email" i]:visible', 'input[name*="user" i]:visible',
      'input[name*="phone" i]:visible', 'input[type="tel"]:visible',
    ]) {
      const candidate = page.locator(selector).first();
      if (await visible(candidate)) return candidate;
    }
    return null;
  };
  const loginButton = async (recipeOnly = false) => {
    const explicit = recipeSteps.find((step) => step?.action === "invoke" && step?.role === "button" && step?.name);
    const labels = explicit ? [explicit.name, ...buttonNames] : buttonNames;
    for (const label of [...new Set(labels)]) {
      if (recipeOnly && label !== explicit?.name) continue;
      const candidate = await findNamed("button", [label]);
      if (candidate && /sign in|log ?in|continue|next|submit|verify|authenticate/i.test(String(label))) return candidate;
    }
    return null;
  };
  const bodyText = async () => clean(await page.locator("body").innerText().catch(() => ""), 8_000);
  const detectorMatches = async (detector) => {
    if (!detector || typeof detector !== "object") return false;
    const [url, title, text] = [page.url(), await page.title().catch(() => ""), await bodyText()];
    return Boolean((!detector.urlIncludes || url.toLowerCase().includes(String(detector.urlIncludes).toLowerCase()))
      && (!detector.titleIncludes || title.toLowerCase().includes(String(detector.titleIncludes).toLowerCase()))
      && (!detector.textIncludes || text.toLowerCase().includes(String(detector.textIncludes).toLowerCase())));
  };
  const anyDetector = async (detectors) => {
    for (const detector of (Array.isArray(detectors) ? detectors : []).slice(0, 12)) if (await detectorMatches(detector)) return true;
    return false;
  };
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(300);
  };
  const initialUrl = page.url();
  const initialChallenge = await challengeFor(page);
  if (initialChallenge.detected) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true, loginState: "challenge_detected" };

  // Reuse safe, label-only recipe steps first. Values are selected only from
  // the broker lease above; the saved recipe never stores them.
  for (const step of recipeSteps) {
    if (!step || typeof step.name !== "string" || !["textbox", "button", "link", "any"].includes(String(step.role))) continue;
    if (step.action === "fill") {
      const field = await findNamed(step.role === "any" ? "textbox" : step.role, [step.name]);
      if (!field) { if (step.optional) continue; break; }
      if (/password|passcode/i.test(step.name)) await field.fill(String(request.password));
      else if (/email|user|login|phone|mobile/i.test(step.name)) await field.fill(String(request.username));
    } else if (step.action === "focus") {
      const field = await findNamed(step.role === "any" ? "textbox" : step.role, [step.name]);
      if (field) await field.focus();
    }
  }

  let submitted = false;
  for (let stepIndex = 0; stepIndex < 4; stepIndex += 1) {
    const challenge = await challengeFor(page);
    if (challenge.detected) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true };
    const password = await passwordInput();
    if (password) {
      await password.fill(String(request.password));
      const submit = await loginButton();
      if (!submit) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true, loginState: "password_step_button_missing" };
      await submit.click({ timeout: 15_000 });
      submitted = true;
      await settle();
      break;
    }
    const username = await usernameInput();
    if (username && !submitted) {
      await username.fill(String(request.username));
      const next = await loginButton();
      if (!next) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true, loginState: "username_step_button_missing" };
      await next.click({ timeout: 15_000 });
      submitted = true;
      await settle();
      continue;
    }
    break;
  }

  const challenge = await challengeFor(page);
  if (challenge.detected) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true, loginState: "challenge_detected" };
  if (await anyDetector(recipe.failure)) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: false, loginState: "failure_detector_matched" };
  const successes = Array.isArray(recipe.success) ? recipe.success.filter((item) => item && item.required !== false) : [];
  const recipeVerified = successes.length > 0 && await (async () => {
    for (const detector of successes) if (!(await detectorMatches(detector))) return false;
    return true;
  })();
  const positiveAuthSignal = await findNamed("link", ["Sign out", "Log out", "My account", "My profile", "Account", "Profile"])
    || await findNamed("button", ["Sign out", "Log out", "My account", "My profile", "Account", "Profile"]);
  const passStillVisible = Boolean(await passwordInput());
  const authenticated = recipeVerified || Boolean(positiveAuthSignal && !passStillVisible);
  if (authenticated) return { ...(await result(page, context)), authenticated: true, needsUserInteraction: false, loginState: "authenticated" };
  const usernameStillVisible = Boolean(await usernameInput());
  const stillLogin = usernameStillVisible || passStillVisible;
  const changedOrigin = (() => { try { return new URL(page.url()).origin !== new URL(initialUrl).origin; } catch { return false; } })();
  const loginState = !submitted ? (usernameStillVisible || passStillVisible ? "login_fields_not_submitted" : "login_form_not_found") : stillLogin ? "credentials_not_accepted" : changedOrigin ? "external_identity_provider_requires_handoff" : "login_success_not_verified";
  return { ...(await result(page, context)), authenticated: false, needsUserInteraction: Boolean(!submitted || stillLogin || changedOrigin), loginUnverified: submitted && !stillLogin && !changedOrigin, loginState };
}

async function start() {
  const browserEnv = { ...process.env, DISPLAY };
  delete browserEnv.CHUSKY_WEB_BOT_AUTH_PRIVATE_KEY_B64;
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, acceptDownloads: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"], viewport: { width: 1440, height: 900 }, env: browserEnv });
  await fs.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(RECORDING_ROOT, { recursive: true, mode: 0o700 });
  context.on("page", (page) => {
    attachDownloadListener(page);
    void interceptPageRequests(context, page);
  });
  for (const page of context.pages()) {
    attachDownloadListener(page);
    await interceptPageRequests(context, page);
  }
  if (!context.pages().length) await context.newPage();
  const pageState = { activeIndex: 0 };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, provider: "e2b", browser: "ready" })); return; }
    if (incoming.method !== "POST" || incoming.url !== "/command") { response.writeHead(404); response.end(); return; }
    let body = ""; incoming.on("data", (chunk) => { body += chunk; if (body.length > 256_000) incoming.destroy(); });
    incoming.on("end", async () => {
      try {
        const request = JSON.parse(body);
        if (typeof request.webBotAuthEnabled === "boolean") webBotAuthActive = request.webBotAuthEnabled && Boolean(signatureDirectory && signingKeyB64);
        let output;
        if (request.action === "vault_login") output = await vaultLogin(context, request);
        else if (request.action === "smoke_fixture") {
          if (process.env.CHUSKY_E2B_SMOKE_TESTS !== "1") throw new Error("Browser smoke fixture is disabled");
          output = await runSmokeFixture(context);
        }
        else if (request.action === "download_claim" || request.action === "recording_claim") {
          const item = (request.action === "download_claim" ? downloaded : recordings).get(String(request.id));
          if (!item || item.state !== "ready") throw new Error("Browser file is not ready");
          output = { ok: true, id: item.id, name: item.name, size: item.size, createdAt: item.createdAt, filePath: item.filePath, kind: request.action === "download_claim" ? "download" : "recording" };
        } else if (request.action === "download_ack" || request.action === "recording_ack") {
          const collection = request.action === "download_ack" ? downloaded : recordings;
          const item = collection.get(String(request.id));
          if (item) { await fs.rm(item.filePath, { force: true }); collection.delete(String(request.id)); }
          output = { ok: true, removed: Boolean(item) };
        } else output = await execute(context, pageState, request);
        pageState.activeIndex = Number(output.activeIndex ?? pageState.activeIndex);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(output));
      } catch (error) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: clean(error?.message || error, 800) }));
      }
    });
  });
  server.listen(8765, "127.0.0.1");
}

if (process.argv.includes("--server")) await start();
