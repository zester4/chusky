import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= "/opt/ms-playwright";
const { chromium } = await import("playwright");

const MAX_MATCHES = 60;
const ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "option", "tab", "heading", "listbox", "img", "switch"];
const PROFILE = "/home/chusky/.cache/chusky-browser";
const DISPLAY = process.env.DISPLAY || ":99";
const clean = (value, max = 180) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const dnsCache = new Map();

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
    const locator = page.getByRole(role, options);
    const count = Math.min(await locator.count(), limit - out.length);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const label = await item.getAttribute("aria-label").catch(() => "");
      const alt = await item.getAttribute("alt").catch(() => "");
      const nameValue = clean(label || await item.innerText().catch(() => "") || alt);
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

async function result(page, context, extra = {}) {
  const challenge = await challengeFor(page);
  return { ok: true, url: page.url(), title: clean(await page.title().catch(() => ""), 160), loadState: "settled", ...(challenge.detected ? { needsUserInteraction: true, challenge } : { challenge }), ...extra, tabs: await tabsFor(context, page), activeIndex: context.pages().indexOf(page) };
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
  } else if (["state", "snapshot", "find"].includes(action)) return result(page, context, { matches: await roleMatches(page, request) });
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
  } else if (action === "type") { if (target) await target.focus(); await page.keyboard.type(String(request.text ?? ""), { delay: Math.max(0, Math.min(250, Number(request.delayMs ?? 0))) }); }
  else if (action === "press") { if (target) await target.focus(); await page.keyboard.press(String(request.key || request.keys || "Enter")); }
  else if (action === "drag") { if (!request.source || !request.target) throw new Error("drag requires source and target accessible selectors"); await locatorFor(page, request.source).dragTo(locatorFor(page, request.target), { timeout: 15_000 }); }
  else if (action === "scroll") await page.mouse.wheel(0, (request.direction === "up" ? -1 : 1) * Math.max(1, Math.min(10, Number(request.amount || 3))) * 600);
  else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "refresh") await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  else if (action === "wait") await page.waitForTimeout(Math.max(50, Math.min(30_000, Number(request.timeoutMs ?? 1_000))));
  else if (["screenshot", "screenshot_full", "screenshot_region"].includes(action)) {
    const clip = action === "screenshot_region" && [request.x, request.y, request.width, request.height].every((value) => Number.isFinite(Number(value))) ? { x: Number(request.x), y: Number(request.y), width: Number(request.width), height: Number(request.height) } : undefined;
    const image = await page.screenshot({ type: "jpeg", quality: 70, fullPage: action === "screenshot_full", ...(clip ? { clip } : {}) });
    return result(page, context, { screenshot: image.toString("base64") });
  } else if (["tabs", "windows"].includes(action)) return result(page, context);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  return result(page, context, { matches: await roleMatches(page) });
}

async function vaultLogin(context, request) {
  const page = context.pages()[0] || await context.newPage();
  await page.goto((await safeHttpUrl(request.url)).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  const names = (value, fallback) => [value, ...fallback].filter(Boolean).map(String);
  const userNames = names(request.usernameFieldLabel, ["Email", "Email address", "Email or username", "Username", "Phone number", "Mobile number"]);
  const passwordNames = names(request.passwordFieldLabel, ["Password", "Your password", "Enter password"]);
  const buttonNames = names(request.submitButtonLabel, ["Sign in", "Log in", "Login", "Continue", "Next", "Submit", "Verify", "Done"]);
  const findOne = async (role, list) => { for (const name of [...new Set(list)]) { const item = page.getByRole(role, { name, exact: true }).first(); if (await item.count() && await item.isVisible().catch(() => false)) return item; } return null; };
  let user = await findOne("textbox", userNames); let pass = await findOne("textbox", passwordNames);
  if (user) { await user.fill(String(request.username)); const next = await findOne("button", buttonNames); if (!pass && next) { await next.click(); await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {}); } }
  pass = pass || await findOne("textbox", passwordNames);
  if (!pass || (await challengeFor(page)).detected) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true };
  await pass.fill(String(request.password)); const submit = await findOne("button", buttonNames);
  if (!submit) return { ...(await result(page, context)), authenticated: false, needsUserInteraction: true };
  await submit.click(); await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 700));
  const stillPassword = await findOne("textbox", passwordNames); const challenge = await challengeFor(page);
  return { ...(await result(page, context)), authenticated: !stillPassword && !challenge.detected, needsUserInteraction: Boolean(stillPassword || challenge.detected) };
}

async function start() {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"], viewport: { width: 1440, height: 900 }, env: { ...process.env, DISPLAY } });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    let parsed;
    try { parsed = new URL(url); } catch { return route.continue(); }
    if (!/^https?:$/.test(parsed.protocol)) return route.continue();
    try {
      await safeHttpUrl(url, request.resourceType() === "document");
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
  if (!context.pages().length) await context.newPage();
  const pageState = { activeIndex: 0 };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, provider: "e2b", browser: "ready" })); return; }
    if (incoming.method !== "POST" || incoming.url !== "/command") { response.writeHead(404); response.end(); return; }
    let body = ""; incoming.on("data", (chunk) => { body += chunk; if (body.length > 256_000) incoming.destroy(); });
    incoming.on("end", async () => { try { const request = JSON.parse(body); const output = request.action === "vault_login" ? await vaultLogin(context, request) : await execute(context, pageState, request); pageState.activeIndex = Number(output.activeIndex ?? pageState.activeIndex); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(output)); } catch (error) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: clean(error?.message || error, 800) })); } });
  });
  server.listen(8765, "127.0.0.1");
}

if (process.argv.includes("--server")) await start();
