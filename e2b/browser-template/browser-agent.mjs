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
const diagnostics = { console: [], errors: [], dialogs: [], pages: [] };
const eventLog = [];
function recordEvent(type, data = {}) {
  eventLog.push({ type, at: Date.now(), ...data });
  if (eventLog.length > 200) eventLog.shift();
}
function boundedRecords(items, limit = 50) { return items.slice(-limit).map((item) => ({ ...item })); }
let webBotAuthActive = Boolean(signatureDirectory && signingKeyB64);
let webBotAuthSigner;

function ensurePageTracking(page) {
  if (page.__chuskyTracking) return page.__chuskyTracking;
  const tracking = { generation: 1, crashed: false, observationId: undefined };
  page.__chuskyTracking = tracking;
  page.on("crash", () => { tracking.crashed = true; tracking.generation += 1; });
  page.on("close", () => { tracking.closed = true; tracking.generation += 1; recordEvent("page_closed", { url: clean(page.url(), 1_000) }); });
  page.on("framenavigated", () => { tracking.generation += 1; });
  page.on("console", (message) => { diagnostics.console.push({ type: message.type(), text: clean(message.text(), 500), url: clean(page.url(), 1_000) }); if (diagnostics.console.length > 100) diagnostics.console.shift(); recordEvent("console", { level: message.type(), text: clean(message.text(), 300) }); });
  page.on("pageerror", (error) => { diagnostics.errors.push({ type: "pageerror", message: clean(error?.message || error, 500), url: clean(page.url(), 1_000) }); if (diagnostics.errors.length > 100) diagnostics.errors.shift(); recordEvent("pageerror", { message: clean(error?.message || error, 300) }); });
  page.on("requestfailed", (request) => { diagnostics.errors.push({ type: "requestfailed", method: request.method(), url: clean(request.url(), 1_000), failure: clean(request.failure()?.errorText || "request failed", 300) }); if (diagnostics.errors.length > 100) diagnostics.errors.shift(); recordEvent("requestfailed", { url: clean(request.url(), 500) }); });
  page.on("dialog", (dialog) => { diagnostics.dialogs.push({ type: dialog.type(), message: clean(dialog.message(), 500), defaultValue: clean(dialog.defaultValue(), 200), url: clean(page.url(), 1_000), handled: "dismissed" }); if (diagnostics.dialogs.length > 50) diagnostics.dialogs.shift(); recordEvent("dialog", { type: dialog.type(), message: clean(dialog.message(), 300) }); void dialog.dismiss().catch(() => {}); });
  void page.evaluate(() => {
    if (window.__chuskyDomGeneration !== undefined) return;
    window.__chuskyDomGeneration = 1;
    new MutationObserver(() => { window.__chuskyDomGeneration += 1; }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }).catch(() => {});
  return tracking;
}

async function pageGeneration(page) {
  const tracking = ensurePageTracking(page);
  const domGeneration = await page.evaluate(() => Number(window.__chuskyDomGeneration || 1)).catch(() => 1);
  return tracking.generation + domGeneration;
}

function frameFor(page, value = {}) {
  const frames = page.frames();
  const requestedIndex = Number(value.frameIndex);
  if (Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < frames.length) {
    const candidate = frames[requestedIndex];
    if (!value.frameUrl || candidate.url() === String(value.frameUrl)) return candidate;
  }
  if (value.frameUrl) {
    const candidate = frames.find((frame) => frame.url() === String(value.frameUrl));
    if (candidate) return candidate;
  }
  return page.mainFrame();
}

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
  let text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (!String(text || "").trim()) text = await page.locator("body").textContent({ timeout: 5_000 }).catch(() => "");
  if (!String(text || "").trim()) text = await page.evaluate(() => document.body?.textContent || document.documentElement?.textContent || "").catch(() => "");
  const bounded = String(text || "").slice(0, MAX_PAGE_TEXT + 1);
  return { pageContent: clean(bounded, MAX_PAGE_TEXT), pageContentTruncated: String(text || "").length > MAX_PAGE_TEXT };
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

function locatorFor(root, value) {
  const role = typeof value?.role === "string" && ROLES.includes(value.role) ? value.role : "button";
  const name = nameMatcher(value);
  if (value?.id) return root.locator(`[id=${JSON.stringify(String(value.id))}]`);
  if (value?.nameAttr) return root.locator(`[name=${JSON.stringify(String(value.nameAttr))}]`);
  if (value?.placeholder) return root.locator(`[placeholder=${JSON.stringify(String(value.placeholder))}]`);
  if (value?.autocomplete) return root.locator(`[autocomplete=${JSON.stringify(String(value.autocomplete))}]`);
  if (role === "file") return root.locator('input[type="file"]').nth(Math.max(0, Number(value?.index ?? 0)));
  const options = name ? { name, exact: value?.nameMatch !== "substring" && value?.nameMatch !== "regex" } : {};
  return root.getByRole(role, options).nth(Math.max(0, Number(value?.index ?? 0)));
}

async function resolveLocator(page, value) {
  // observation_stale remains the error vocabulary for unrecoverable stale
  // observations, but IDs and DOM generations are advisory for form actions.
  // Form
  // workflows commonly reuse controls from one snapshot across several
  // sequential fills, and successful actions emit newer observations. Always
  // re-resolve the current stable/accessibility selector below; missing or
  // ambiguous controls still fail safely instead of acting on a stale node.
  const root = frameFor(page, value);
  const role = typeof value?.role === "string" && ROLES.includes(value.role) ? value.role : "button";
  const name = nameMatcher(value);
  const options = name ? { name, exact: value?.nameMatch !== "substring" && value?.nameMatch !== "regex" } : {};
  const roleLocator = role === "file" ? root.locator('input[type="file"]') : root.getByRole(role, options);
  const count = await roleLocator.count();
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = roleLocator.nth(index);
    if (role === "file" || await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (value?.id || value?.nameAttr || value?.placeholder || value?.autocomplete) {
    const preferred = locatorFor(root, value);
    if (await preferred.count() === 1 && (role === "file" || await preferred.isVisible().catch(() => false))) return preferred;
  }
  if (visible.length === 1) return visible[0];
  const index = Number(value?.index);
  if (Number.isSafeInteger(index) && index >= 0 && index < visible.length) return visible[index];
  if (!visible.length) throw new Error(`Accessible ${role} control ${name ? `"${name}" ` : ""}was not found on the current page`);
  throw new Error(`Accessible ${role} control ${name ? `"${name}" ` : ""}is ambiguous (${visible.length} visible matches); inspect again and choose a specific control`);
}

async function controlState(locator) {
  return await locator.evaluate((element) => {
    const input = element;
    const state = { controlRole: input.getAttribute("role") || input.tagName.toLowerCase() };
    if (typeof input.value === "string") { state.value = input.value; state.valueLength = input.value.length; }
    state.required = input.required === true || input.getAttribute("aria-required") === "true";
    state.disabled = input.disabled === true || input.getAttribute("aria-disabled") === "true";
    const invalid = input.getAttribute("aria-invalid") === "true" || (typeof input.checkValidity === "function" && !input.checkValidity());
    if (invalid) {
      state.invalid = true;
      state.validationMessage = String(input.validationMessage || "").slice(0, 300);
    }
    if (typeof input.checked === "boolean") state.checked = input.checked;
    const ariaChecked = input.getAttribute("aria-checked");
    if (ariaChecked === "true" || ariaChecked === "false") state.checked = ariaChecked === "true";
    const dataState = input.getAttribute("data-state");
    if (dataState === "checked" || dataState === "unchecked") state.checked = dataState === "checked";
    const dataChecked = input.getAttribute("data-checked");
    if (dataChecked === "true" || dataChecked === "false") state.checked = dataChecked === "true";
    if (input.tagName.toLowerCase() === "select") state.selectedText = Array.from(input.selectedOptions || []).map((option) => option.textContent || "").join(", ").trim();
    if (input.getAttribute("role") === "combobox") state.selectedText = (input.innerText || input.textContent || "").trim().slice(0, 300);
    return state;
  }).catch(() => ({}));
}

async function clickControl(page, locator) {
  try {
    await locator.click({ timeout: 15_000 });
    return;
  } catch (firstError) {
    // Custom controls can remain visible while an animation or transparent
    // wrapper blocks Playwright's normal actionability check. Use one bounded
    // fallback and let the caller verify the resulting state or transition.
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    try {
      await locator.click({ timeout: 5_000, force: true });
      return;
    } catch {
      const box = await locator.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      throw firstError;
    }
  }
}

async function setCheckbox(locator, desired) {
  const native = await locator.evaluate((element) => element instanceof HTMLInputElement && element.type === "checkbox").catch(() => false);
  if (native) {
    if (desired) await locator.check({ timeout: 15_000 });
    else await locator.uncheck({ timeout: 15_000 });
  } else {
    const current = await controlState(locator);
    if (current.checked !== desired) await locator.click({ timeout: 15_000 });
  }
  const after = await controlState(locator);
  if (after.checked !== desired) throw new Error(`Checkbox state did not become ${desired ? "checked" : "unchecked"}`);
  return after;
}

async function selectControl(page, locator, value, root) {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tagName === "select") {
    try { await locator.selectOption({ label: String(value) }); }
    catch { await locator.selectOption(String(value)); }
  } else {
    try {
      await clickControl(page, locator);
      const option = root.getByRole("option", { name: String(value), exact: true }).first();
      if (await option.count()) await clickControl(page, option);
      else {
        const visibleText = root.getByText(String(value), { exact: true }).first();
        if (!(await visibleText.count())) throw new Error(`Dropdown option "${String(value).slice(0, 120)}" was not found`);
        await clickControl(page, visibleText);
      }
    } catch (error) {
      // Many custom comboboxes expose keyboard semantics even when their
      // popup is not a native ARIA listbox. Focus, type the requested label,
      // and commit with Enter before verifying the resulting state.
      await locator.focus({ timeout: 15_000 });
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(String(value), { delay: 15 });
      await page.keyboard.press("Enter");
      if (!String(error?.message || error).trim()) throw error;
    }
  }
  const state = await controlState(locator);
  const selected = state.selectedText || state.value || "";
  if (!selected.toLowerCase().includes(String(value).toLowerCase())) throw new Error(`Dropdown did not select "${String(value).slice(0, 120)}"`);
  return state;
}

function normalizeAutocompleteText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

async function clickVisibleAutocompleteCard(page, locator, value, root) {
  const token = `chusky-autocomplete-${randomUUID()}`;
  const marked = await locator.evaluate((input, details) => {
    const normalize = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
    const requested = normalize(details.value);
    const inputRect = input.getBoundingClientRect();
    const inputStyle = getComputedStyle(input);
    if (!requested || inputStyle.display === "none" || inputStyle.visibility === "hidden" || inputRect.width < 1 || inputRect.height < 1) return false;
    const candidates = [];
    for (const element of Array.from(document.querySelectorAll("body *")).slice(-1_200)) {
      if (element === input || input.contains(element) || element.contains(input)) continue;
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 500) continue;
      const lines = String(element.textContent || "").split(/\r?\n/).map((line) => normalize(line)).filter(Boolean);
      if (!lines.some((line) => line === requested || line.includes(requested))) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0 || rect.width < 8 || rect.height < 8) continue;
      if (rect.top < inputRect.bottom - 4 || rect.top > inputRect.bottom + 900) continue;
      const horizontallyNear = rect.right >= inputRect.left - 500 && rect.left <= inputRect.right + 500;
      if (!horizontallyNear) continue;
      if (rect.width > Math.max(inputRect.width * 1.8, 620) || rect.height > 280) continue;
      const clickable = /^(A|BUTTON|LI)$/.test(element.tagName) || element.getAttribute("role") === "option" || element.getAttribute("role") === "listitem" || style.cursor === "pointer" || element.tabIndex >= 0;
      const normalized = normalize(text);
      const exactLine = lines.includes(requested) || normalized === requested || normalized.startsWith(`${requested} `);
      candidates.push({ element, top: rect.top, area: rect.width * rect.height, clickable, exactLine });
    }
    candidates.sort((left, right) => Number(right.exactLine) - Number(left.exactLine) || Number(right.clickable) - Number(left.clickable) || left.top - right.top || left.area - right.area);
    const chosen = candidates[0]?.element;
    if (!chosen) return false;
    chosen.setAttribute("data-chusky-autocomplete-target", details.token);
    return true;
  }, { value: String(value), token }).catch(() => false);
  if (!marked) return { selected: false };
  const candidate = root.locator(`[data-chusky-autocomplete-target=${JSON.stringify(token)}]`).first();
  try {
    const label = normalizeAutocompleteText(await candidate.innerText().catch(() => String(value)));
    await clickControl(page, candidate);
    return { selected: true, label: label || normalizeAutocompleteText(value), visual: true };
  } finally {
    await candidate.evaluate((element) => element.removeAttribute("data-chusky-autocomplete-target")).catch(() => {});
  }
}

async function selectUniqueAutocomplete(page, locator, value, root) {
  const metadata = await locator.evaluate((element) => ({
    role: element.getAttribute("role") || "",
    autocomplete: element.getAttribute("aria-autocomplete") || "",
    controls: element.getAttribute("aria-controls") || "",
  })).catch(() => ({ role: "", autocomplete: "", controls: "" }));
  const detected = metadata.role === "combobox" || metadata.autocomplete || metadata.controls;
  if (!detected) return { selected: false, autocompleteDetected: false };
  const requested = normalizeAutocompleteText(value);
  if (requested.length < 2) return { selected: false, autocompleteDetected: true, candidates: 0 };
  const optionLocators = [root.getByRole("option")];
  for (const controlId of String(metadata.controls || "").split(/\s+/).filter(Boolean).slice(0, 4)) {
    const controlled = `[id=${JSON.stringify(controlId)}]`;
    optionLocators.push(root.locator(`${controlled} [role="option"], ${controlled} option`));
    optionLocators.push(root.locator(controlled).getByRole("option"));
  }
  const inspectOptions = async () => {
    const visible = [];
    const seen = new Set();
    for (const options of optionLocators) {
      const count = Math.min(await options.count(), 40);
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (!(await option.isVisible().catch(() => false))) continue;
        const label = normalizeAutocompleteText(await option.innerText().catch(() => ""));
        if (!label || seen.has(label)) continue;
        seen.add(label);
        const exact = label === requested || (requested.length >= 4 && label.includes(requested));
        if (exact) visible.push({ option, label });
      }
    }
    return visible;
  };
  let visible = await inspectOptions();
  // Some production comboboxes only open their popup for keyboard-generated
  // input events. Playwright fill is preferred, but retype once through the
  // control when the popup did not react; this remains bounded and idempotent.
  if (!visible.length) {
    await locator.focus().catch(() => {});
    await locator.press("ControlOrMeta+A").catch(() => {});
    await locator.pressSequentially(String(value), { delay: 15 }).catch(() => {});
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    visible = await inspectOptions();
    if (visible.length >= 1) {
      await clickControl(page, visible[0].option);
      return { selected: true, autocompleteDetected: true, autocompleteCandidates: visible.length, autocompleteAmbiguous: visible.length > 1, label: visible[0].label };
    }
    if (visible.length === 0 && attempt % 2 === 0) {
      const visual = await clickVisibleAutocompleteCard(page, locator, value, root);
      if (visual.selected) return { selected: true, autocompleteDetected: true, autocompleteVisualFallback: true, label: visual.label };
    }
    if (attempt < 4) await page.waitForTimeout(300);
  }
  return { selected: false, autocompleteDetected: true, candidates: visible.length };
}

async function fillControl(page, locator, value, root = page.mainFrame()) {
  const beforeUrl = page.url();
  try {
    await locator.fill(value);
  } catch (error) {
    await locator.focus({ timeout: 15_000 });
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(value, { delay: 10 });
    if (!String(error?.message || error).trim()) throw error;
  }
  // A few custom widgets listen for a native input event but do not react to
  // programmatic value assignment alone. Re-dispatch the bounded event before
  // inspecting their popup; this does not bypass the widget's own selection
  // logic and keeps verification anchored to the resulting option.
  await locator.dispatchEvent("input").catch(() => {});
  const autocomplete = await selectUniqueAutocomplete(page, locator, value, root);
  const navigatedAfterSelection = autocomplete.selected && page.url() !== beforeUrl;
  if (navigatedAfterSelection) return { controlRole: "combobox", value, valueLength: value.length, required: false, disabled: false, checked: false, autocompleteDetected: true, autocompleteSelected: true, autocompleteNavigated: true, autocompleteLabel: autocomplete.label, ...(autocomplete.autocompleteCandidates !== undefined ? { autocompleteCandidates: autocomplete.autocompleteCandidates } : {}) };
  if (autocomplete.selected) {
    const normalizedValue = normalizeAutocompleteText(value);
    const currentPageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (normalizedValue && normalizeAutocompleteText(currentPageText).includes(normalizedValue)) {
      return { controlRole: "combobox", value, valueLength: value.length, required: false, disabled: false, checked: false, autocompleteDetected: true, autocompleteSelected: true, autocompleteCommittedByPage: true, autocompleteLabel: autocomplete.label, ...(autocomplete.autocompleteCandidates !== undefined ? { autocompleteCandidates: autocomplete.autocompleteCandidates } : {}) };
    }
  }
  const state = await controlState(locator);
  if (state.value !== value && state.valueLength !== value.length) {
    if (autocomplete.selected) return { ...state, autocompleteDetected: true, autocompleteSelectionFailed: true, ...(autocomplete.autocompleteVisualFallback ? { autocompleteVisualFallback: true } : {}), ...(autocomplete.autocompleteCandidates !== undefined ? { autocompleteCandidates: autocomplete.autocompleteCandidates } : {}) };
    throw new Error("Field value did not persist after fill");
  }
  return { ...state, ...(autocomplete.autocompleteDetected ? { autocompleteDetected: true } : {}), ...(autocomplete.candidates !== undefined ? { autocompleteCandidates: autocomplete.candidates } : {}), ...(autocomplete.autocompleteCandidates !== undefined ? { autocompleteCandidates: autocomplete.autocompleteCandidates } : {}), ...(autocomplete.autocompleteAmbiguous ? { autocompleteAmbiguous: true } : {}), ...(autocomplete.selected ? { autocompleteSelected: true, autocompleteLabel: autocomplete.label } : {}) };
}

async function applyFormControl(page, control) {
  const locator = await resolveLocator(page, control);
  await locator.waitFor({ state: "attached", timeout: 10_000 });
  const action = String(control.action || "fill");
  if (action === "fill") return fillControl(page, locator, String(control.value ?? ""), frameFor(page, control));
  if (action === "select_option") return selectControl(page, locator, String(control.value ?? ""), frameFor(page, control));
  if (action === "check") return setCheckbox(locator, true);
  if (action === "uncheck") return setCheckbox(locator, false);
  throw new Error(`Unsupported planned form action: ${action}`);
}

async function roleMatches(page, request = {}) {
  ensurePageTracking(page);
  const requestedRole = typeof request.role === "string" && ROLES.includes(request.role) ? request.role : undefined;
  const roles = requestedRole ? [requestedRole] : ROLES;
  const out = [];
  const name = request.name ? nameMatcher(request) : undefined;
  const options = name ? { name, exact: request.nameMatch !== "substring" && request.nameMatch !== "regex" } : {};
  const limit = Math.max(1, Math.min(MAX_MATCHES, Number(request.limit ?? MAX_MATCHES)));
  for (const frame of page.frames()) {
    const root = frame;
    try {
    for (const role of roles) {
    const locator = role === "file" ? root.locator('input[type="file"]') : root.getByRole(role, options);
    const count = Math.min(await locator.count(), limit - out.length);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (role !== "file" && !(await item.isVisible().catch(() => false))) continue;
      const label = await item.getAttribute("aria-label").catch(() => "");
      const alt = await item.getAttribute("alt").catch(() => "");
      const id = await item.getAttribute("id").catch(() => "");
      const nameAttr = await item.getAttribute("name").catch(() => "");
      const placeholder = await item.getAttribute("placeholder").catch(() => "");
      const autocomplete = await item.getAttribute("autocomplete").catch(() => "");
      const inputType = await item.getAttribute("type").catch(() => "");
      const tagName = await item.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
      const associated = await item.evaluate((element) => {
        const input = element;
        const labels = Array.from(input.labels || []).map((label) => label.innerText || label.textContent || "");
        if (labels.length) return labels.join(" ");
        const labelledBy = input.getAttribute("aria-labelledby");
        if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
        return input.getAttribute("title") || input.getAttribute("name") || input.getAttribute("accept") || (input.type === "file" ? "File upload" : "");
      }).catch(() => role === "file" ? "File upload" : "");
      const visibleText = await item.innerText().catch(() => "");
      // Selects expose their option text as innerText, but their accessible
      // control name comes from the associated label. Prefer that label for
      // form controls so discovery returns "Business headquarters" rather
      // than "Select... Ghana United Kingdom".
      const nameValue = clean(label || ((tagName === "select" || inputType) ? associated : visibleText) || alt || associated);
      if (name && !String(nameValue).toLowerCase().includes(String(name).toLowerCase())) continue;
      if (nameValue) out.push({ role, name: nameValue, index, frameIndex: page.frames().indexOf(frame), frameUrl: clean(frame.url(), 1_000), ...(id ? { id: clean(id, 160) } : {}), ...(nameAttr ? { nameAttr: clean(nameAttr, 160) } : {}), ...(placeholder ? { placeholder: clean(placeholder, 200) } : {}), ...(autocomplete ? { autocomplete: clean(autocomplete, 80) } : {}), ...(inputType ? { inputType: clean(inputType, 40) } : {}), ...(tagName ? { tagName } : {}), ...(role === "link" ? { href: clean(await item.getAttribute("href").catch(() => ""), 1_000) } : {}) });
    }
    if (out.length >= limit) break;
    }
    } catch (error) {
      recordEvent("frame_observation_error", { frameUrl: clean(frame.url?.() || "", 1_000), message: clean(error?.message || error, 300) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function linkMatches(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const links = await frame.locator("a[href]").evaluateAll((items) => items.slice(0, 200).map((item, index) => ({
        role: "link",
        name: String(item.getAttribute("aria-label") || item.textContent || item.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 300),
        href: item.href,
        index,
        visible: Boolean(item.getClientRects().length && getComputedStyle(item).visibility !== "hidden"),
      })));
      for (const link of links) {
        if (link.visible && link.name && link.href && out.length < 200) out.push({ ...link, frameIndex: page.frames().indexOf(frame), frameUrl: clean(frame.url(), 1_000) });
      }
    } catch (error) {
      recordEvent("frame_link_inventory_error", { frameUrl: clean(frame.url?.() || "", 1_000), message: clean(error?.message || error, 300) });
    }
  }
  return out;
}

async function inspectForms(page) {
  const forms = [];
  for (const frame of page.frames()) {
    const frameForms = await frame.evaluate(() => {
      const cleanText = (value, max = 180) => String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
      const labelFor = (element) => {
        const labels = Array.from(element.labels || []).map((label) => label.innerText || label.textContent || "");
        if (labels.length) return cleanText(labels.join(" "));
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) return cleanText(labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
        return cleanText(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("name") || "");
      };
      const serializeControl = (element) => {
        const input = element;
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute("role") || (tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (input.type === "checkbox" ? "checkbox" : input.type === "radio" ? "radio" : "textbox") : tag === "button" ? "button" : "textbox");
        const type = tag === "input" ? String(input.type || "text").toLowerCase() : tag;
        const rawValue = typeof input.value === "string" ? input.value : "";
        const selected = tag === "select" ? Array.from(input.selectedOptions || []).map((option) => option.textContent || "").join(", ") : undefined;
        const invalid = element.getAttribute("aria-invalid") === "true" || (typeof input.checkValidity === "function" && !input.checkValidity());
        const describedBy = element.getAttribute("aria-errormessage") || element.getAttribute("aria-describedby") || "";
        const validationMessage = cleanText(describedBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ") || (invalid && typeof input.validationMessage === "string" ? input.validationMessage : ""), 300);
        return {
          ...(element.id ? { id: cleanText(element.id, 160) } : {}),
          role: cleanText(role, 40), type: cleanText(type, 40), name: labelFor(element), required: element.required === true || element.getAttribute("aria-required") === "true", disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
          ...(rawValue ? { valuePresent: true, valueLength: rawValue.length } : { valuePresent: false, valueLength: 0 }),
          ...(typeof input.checked === "boolean" ? { checked: input.checked } : {}), ...(selected ? { selectedText: cleanText(selected, 300) } : {}),
          ...(tag === "select" ? { options: Array.from(input.options || []).slice(0, 100).map((option) => ({ label: cleanText(option.textContent || "", 160), value: cleanText(option.value || "", 160), disabled: option.disabled === true, selected: option.selected === true })) } : {}),
          ...(invalid ? { invalid: true } : {}), ...(validationMessage ? { validationMessage } : {}),
        };
      };
      const selector = 'input,select,textarea,button,[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"]';
      const roots = Array.from(document.querySelectorAll("form"));
      const groups = roots.length ? roots : [document.body];
      return groups.slice(0, 40).map((root, index) => {
        const controls = Array.from(root.querySelectorAll(selector)).filter((element) => !element.closest("form") || element.closest("form") === root).map(serializeControl);
        const submitControls = Array.from(root.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')).slice(0, 20).map((element) => ({ role: element.getAttribute("role") || "button", name: labelFor(element) || cleanText(element.innerText || element.value || "Submit"), ...(element.id ? { id: cleanText(element.id, 160) } : {}), disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true" }));
        return { formId: root.id ? cleanText(root.id, 160) : `implicit-${index}`, ...(root.getAttribute("aria-label") ? { name: cleanText(root.getAttribute("aria-label"), 180) } : {}), ...(root.getAttribute("action") ? { action: cleanText(root.getAttribute("action"), 500) } : {}), ...(root.getAttribute("method") ? { method: cleanText(root.getAttribute("method"), 20).toUpperCase() } : {}), controls, submitControls };
      }).filter((form) => form.controls.length || form.submitControls.length);
    }).catch(() => []);
    for (const form of frameForms) forms.push({ ...form, controls: form.controls.map((control) => ({ ...control, frameIndex: page.frames().indexOf(frame), frameUrl: clean(frame.url(), 1_000) })), submitControls: form.submitControls.map((control) => ({ ...control, frameIndex: page.frames().indexOf(frame), frameUrl: clean(frame.url(), 1_000) })) });
  }
  return forms;
}

async function challengeFor(page) {
  let mainOrigin = "";
  try { mainOrigin = new URL(page.url()).origin; } catch {}
  for (const frame of page.frames()) {
    try {
      const url = frame.url().toLowerCase();
      const title = clean(await frame.title().catch(() => ""), 200).toLowerCase();
      const text = clean(await frame.locator("body").innerText().catch(() => ""), 4_000).toLowerCase();
      const source = `${url} ${title} ${text}`;
      const captcha = /(captcha|recaptcha|hcaptcha|cloudflare.*verify|verify you are human|checking your browser|robot or human|are you a robot|automated traffic|access denied|human verification|human challenge|press & hold)/.test(source);
      let sameOrigin = false;
      try { sameOrigin = frame === page.mainFrame() || new URL(url).origin === mainOrigin; } catch {}
      const twoFactor = sameOrigin && /(two[- ]factor|2fa|one[- ]time password|one[- ]time code|verification code|security code|authenticator app|security key|passkey|approve sign[- ]in|magic link)/.test(source);
      if (captcha || twoFactor) return { detected: true, type: captcha ? "captcha" : "two_factor", frameUrl: clean(url, 1_000) };
    } catch (error) {
      recordEvent("challenge_frame_inspection_error", { message: clean(error?.message || error, 300) });
    }
  }
  return { detected: false };
}

async function tabsFor(context, active) {
  return Promise.all(context.pages().slice(0, 10).map(async (page, index) => ({ index, url: page.url(), title: clean(await page.title().catch(() => ""), 160), active: page === active })));
}

async function healthSnapshot(context) {
  const pages = context.pages();
  const crashed = pages.some((page) => ensurePageTracking(page).crashed);
  return {
    ok: !crashed && pages.some((page) => !page.isClosed()),
    provider: "e2b",
    browser: crashed ? "unhealthy" : "ready",
    daemon: "ready",
    chromium: crashed ? "crashed" : (pages.length ? "ready" : "starting"),
    display: DISPLAY,
    pageCount: pages.length,
    activeUrl: pages[0]?.url() || "about:blank",
  };
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
  // Allow initial hydration and observer delivery to settle before sealing an
  // observation. This remains bounded and avoids treating the same render
  // transaction as a stale page between snapshot and the next action.
  await page.waitForTimeout(50).catch(() => {});
  const tracking = ensurePageTracking(page);
  const generation = await pageGeneration(page);
  const observationId = randomUUID();
  tracking.observationId = observationId;
  const suppliedMatches = Array.isArray(extra.matches) ? extra.matches : undefined;
  const matches = suppliedMatches?.map((item) => ({ ...item, observationId, pageGeneration: generation }))
    ?? await roleMatches(page);
  const accessibilityHash = createHash("sha256").update(JSON.stringify(matches.map(({ role, name, index, frameIndex, frameUrl }) => ({ role, name, index, frameIndex, frameUrl })))).digest("hex").slice(0, 24);
  const challenge = await challengeFor(page);
  return { ok: true, url: page.url(), title: clean(await page.title().catch(() => ""), 160), loadState: "settled", observationId, pageGeneration: generation, accessibilityHash, ...(challenge.detected ? { needsUserInteraction: true, challenge } : { challenge }), ...(includePageContent ? await pageText(page) : {}), ...extra, ...(matches ? { matches } : {}), tabs: await tabsFor(context, page), activeIndex: context.pages().indexOf(page) };
}

async function runSmokeFixture(context, pageState) {
  // Keep the generic fixture disposable. Retailer navigation owns its page;
  // replacing its DOM made slow/challenge pages look like browser crashes.
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><title>Chusky E2B browser fixture</title></head><body>
    <main><h1>Browser integration fixture</h1><p>Visible content proves page reading works.</p>
    <label for="query">Search fixture</label><input id="query" aria-label="Search fixture" />
    <button id="continue">Continue</button><output id="output"></output>
    <form id="account-form">
      <label for="first-name">Legal first name</label><input id="first-name" autocomplete="given-name" />
      <label for="last-name">Legal last name</label><input id="last-name" autocomplete="family-name" />
      <label for="business-email">Business email</label><input id="business-email" type="email" autocomplete="email" />
      <label for="country">Business headquarters</label><select id="country"><option value="">Select...</option><option value="ghana">Ghana</option><option value="united-kingdom">United Kingdom</option></select>
      <label for="password">Create a password</label><input id="password" type="password" autocomplete="new-password" />
      <label><input id="terms" type="checkbox" /> I agree to the Terms &amp; Conditions</label>
      <button id="create-account" type="submit">Create sandbox account</button>
    </form>
    <form id="survey-form">
      <label for="survey-name">Your name (optional)</label><input id="survey-name" placeholder="Anonymous" />
      <fieldset><legend>Which topics interest you? (select all that apply)</legend>
        <label><input type="checkbox" name="topic" value="technology" /> Technology</label>
        <label><input type="checkbox" name="topic" value="sports" /> Sports</label>
        <label><input type="checkbox" name="topic" value="music" /> Music</label>
        <label><input type="checkbox" name="topic" value="travel" /> Travel</label>
      </fieldset>
      <fieldset><legend>How would you rate your experience?</legend>
        <label><input type="radio" name="rating" value="1" /> 1</label>
        <label><input type="radio" name="rating" value="2" /> 2</label>
        <label><input type="radio" name="rating" value="3" /> 3</label>
        <label><input type="radio" name="rating" value="4" /> 4</label>
        <label><input type="radio" name="rating" value="5" /> 5</label>
      </fieldset>
      <button id="survey-submit" type="submit">Submit survey</button>
    </form>
    <form id="ride-form">
      <label for="pickup-location">Pickup location</label>
      <input id="pickup-location" role="combobox" aria-autocomplete="list" aria-controls="pickup-options" autocomplete="street-address" />
      <ul id="pickup-options" role="listbox" hidden></ul>
      <label for="dropoff-location">Dropoff location</label>
      <input id="dropoff-location" role="combobox" aria-autocomplete="list" aria-controls="dropoff-options" autocomplete="street-address" />
      <ul id="dropoff-options" role="listbox" hidden></ul>
    </form>
    <label for="upload">Attach fixture file</label><input id="upload" type="file" aria-label="Attach fixture file" />
    <a id="download" download="fixture.txt" href="data:text/plain;base64,Q2h1c2t5IEUyQiBkb3dubG9hZCBmaXh0dXJl">Download fixture</a>
    <div style="height:2400px">End of long page</div></main>
    <script>
      document.querySelector('#continue').addEventListener('click',()=>{document.querySelector('#output').textContent='Submitted: '+document.querySelector('#query').value});
      document.querySelector('#account-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget;document.querySelector('#output').textContent='Account submitted: '+form.elements['first-name'].value+' '+form.elements['last-name'].value+' '+form.elements['business-email'].value+' '+form.elements.country.value+' terms='+form.elements.terms.checked});
      document.querySelector('#survey-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget;document.querySelector('#output').textContent='Survey submitted: '+(form.elements['survey-name'].value||'Anonymous')+' topics='+[...form.querySelectorAll('input[name="topic"]:checked')].map((input)=>input.value).join(',')+' rating='+form.elements.rating.value});
      document.querySelector('#upload').addEventListener('change',(event)=>{document.querySelector('#output').textContent+='; Uploaded: '+(event.target.files?.[0]?.name||'none')});
      const locations=['Los Angeles International Airport','Santa Monica Pier','Union Station Los Angeles'];
      const wireLocation=(inputId,listId)=>{const input=document.querySelector('#'+inputId);const list=document.querySelector('#'+listId);input.addEventListener('input',()=>{const query=input.value.toLowerCase();list.replaceChildren(...locations.filter((item)=>item.toLowerCase().includes(query)).map((item)=>{const option=document.createElement('li');option.setAttribute('role','option');option.textContent=item;option.addEventListener('click',()=>{input.value=item;list.hidden=true});return option;}));list.hidden=!query||!list.children.length});};
      wireLocation('pickup-location','pickup-options');wireLocation('dropoff-location','dropoff-options');
    </script>
  </body></html>`);
  const output = await result(page, context, { matches: await roleMatches(page) }, true);
  pageState.activeIndex = output.activeIndex;
  return output;
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

function normalizedText(value) { return clean(value, 300).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function extractRequestedSchema(page, schema) {
  const forms = await inspectForms(page);
  const nodes = await roleMatches(page, {});
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? Object.entries(schema.properties).slice(0, 100) : [];
  const extracted = {};
  for (const [key, definition] of properties) {
    const item = definition && typeof definition === "object" ? definition : {};
    const label = normalizedText(item.label || key);
    let control;
    for (const form of forms) {
      control = form.controls.find((candidate) => {
        const name = normalizedText(candidate.name);
        return (!item.role || candidate.role === item.role) && name && (name === label || name.includes(label) || label.includes(name));
      });
      if (control) break;
    }
    if (control) {
      if (["checkbox", "radio", "switch"].includes(control.role)) extracted[key] = control.checked === true;
      else if (control.selectedText !== undefined) extracted[key] = control.selectedText;
      else extracted[key] = { present: true, role: control.role, name: control.name, valuePresent: control.valuePresent === true, valueLength: control.valueLength || 0 };
      continue;
    }
    const node = nodes.find((candidate) => {
      const name = normalizedText(candidate.name);
      return (!item.role || candidate.role === item.role) && name && (name === label || name.includes(label) || label.includes(name));
    });
    if (node) extracted[key] = { present: true, role: node.role, name: node.name, nodeId: node.nodeId };
  }
  return { extracted, forms };
}

function agentStepKey(step) {
  const selector = step?.selector && typeof step.selector === "object" ? step.selector : undefined;
  return JSON.stringify({
    action: typeof step?.action === "string" ? step.action : "",
    selector: selector ? {
      role: selector.role,
      name: selector.name,
      id: selector.id,
      nameAttr: selector.nameAttr,
      placeholder: selector.placeholder,
      autocomplete: selector.autocomplete,
      index: selector.index,
      frameIndex: selector.frameIndex,
      frameUrl: selector.frameUrl,
    } : undefined,
    value: step?.value,
    text: step?.text,
    key: step?.key,
    x: step?.x,
    y: step?.y,
  });
}

function agentProgressMarker(value) {
  return JSON.stringify({
    url: value?.url,
    title: value?.title,
    pageGeneration: value?.pageGeneration,
    accessibilityHash: value?.accessibilityHash,
    screenshotHash: value?.screenshotHash,
    submitted: value?.submitted,
  });
}

async function assertionLocator(page, assertion) {
  const value = String(assertion?.value || "").trim().slice(0, 300);
  if (!value) return undefined;
  const roles = assertion.kind === "checked"
    ? ["checkbox", "switch", "radio"]
    : assertion.kind === "selected"
      ? ["combobox", "listbox", "option"]
      : assertion.kind === "field"
        ? ["textbox", "combobox"]
        : ["button", "link", "textbox", "combobox", "checkbox", "radio", "switch", "option", "tab"];
  for (const role of roles) {
    const locator = page.getByRole(role, { name: value, exact: true });
    const visible = [];
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length === 1) return visible[0];
  }
  const labelled = page.getByLabel(value, { exact: false });
  if (await labelled.count().catch(() => 0) === 1 && await labelled.first().isVisible().catch(() => false)) return labelled.first();
  return undefined;
}

async function verifyAgentExpectations(page, expectations) {
  const checks = [];
  for (const assertion of Array.isArray(expectations) ? expectations.slice(0, 12) : []) {
    const kind = String(assertion?.kind || "").slice(0, 40);
    const value = String(assertion?.value || "").slice(0, 300);
    const required = assertion?.required !== false;
    let observed;
    let passed = false;
    try {
      if (kind === "url") observed = page.url();
      else if (kind === "title") observed = await page.title().catch(() => "");
      else if (kind === "text") observed = (await pageText(page)).pageContent;
      else {
        const locator = await assertionLocator(page, assertion);
        if (!locator) throw new Error(`Expected ${kind || "control"} "${clean(value, 120)}" was not found`);
        if (kind === "visible") observed = await locator.isVisible().catch(() => false);
        else if (kind === "checked") observed = (await controlState(locator)).checked === true;
        else if (kind === "selected") observed = (await controlState(locator)).selectedText || await locator.innerText().catch(() => "");
        else if (kind === "field") observed = (await controlState(locator)).value || "";
        else throw new Error(`Unsupported browser assertion kind "${kind}"`);
      }
      if (typeof assertion?.equals === "boolean") passed = observed === assertion.equals;
      else if (typeof assertion?.equals === "string") passed = String(observed ?? "").toLowerCase() === assertion.equals.toLowerCase();
      else if (kind === "checked" || kind === "visible") passed = observed === true;
      else passed = String(observed ?? "").toLowerCase().includes(value.toLowerCase());
    } catch (error) {
      observed = clean(error?.message || error, 240);
      passed = false;
    }
    checks.push({ kind, value, required, passed, ...(typeof observed === "boolean" ? { observed } : {}) });
  }
  return { passed: checks.every((item) => !item.required || item.passed), checks };
}

async function boundedAgentRun(context, pageState, request) {
  const maxSteps = Math.max(1, Math.min(50, Number(request.maxSteps || 20)));
  const maxActions = Math.max(1, Math.min(maxSteps, Number(request.maxActions || maxSteps)));
  const maxDurationMs = Math.max(1_000, Math.min(120_000, Number(request.maxDurationMs || 45_000)));
  const noProgressLimit = Math.max(1, Math.min(3, Number(request.noProgressLimit || 2)));
  const steps = Array.isArray(request.steps) ? request.steps.slice(0, maxSteps) : [];
  if (!steps.length) throw new Error("agent requires at least one bounded browser step");
  const trace = [];
  let last;
  let previousKey;
  let previousMarker;
  let noProgressCount = 0;
  let actionCount = 0;
  let stoppedReason = "completed";
  let completionChecks = [];
  let verified = false;
  const startedRunAt = Date.now();
  const guardedActions = new Set(["click", "invoke", "fill", "select_option", "check", "uncheck", "focus", "hover", "press", "scroll", "drag"]);
  for (let index = 0; index < steps.length; index += 1) {
    if (Date.now() - startedRunAt >= maxDurationMs) {
      stoppedReason = "timeout";
      break;
    }
    if (actionCount >= maxActions) {
      stoppedReason = "max_actions";
      break;
    }
    const step = steps[index];
    if (!step || typeof step !== "object" || typeof step.action !== "string" || ["agent", "act", "observe"].includes(step.action)) throw new Error(`agent step ${index + 1} is invalid or recursive`);
    const startedAt = Date.now();
    const key = agentStepKey(step);
    try {
      last = await execute(context, pageState, step);
      actionCount += 1;
      if (last?.needsUserInteraction === true && last?.challenge?.detected === true) {
        trace.push({ index, action: step.action, status: "stopped", durationMs: Date.now() - startedAt, observedUrl: last?.url, observedTitle: last?.title, observedPageGeneration: last?.pageGeneration, observedAccessibilityHash: last?.accessibilityHash, screenshotHash: last?.screenshotHash, recovery: "handoff" });
        stoppedReason = "challenge";
        break;
      }
      const marker = agentProgressMarker(last);
      const progress = marker !== previousMarker;
      if (key === previousKey && marker === previousMarker && guardedActions.has(step.action)) noProgressCount += 1;
      else noProgressCount = 0;
      const expectationResult = await verifyAgentExpectations(context.pages()[Math.max(0, Number(pageState.activeIndex || 0))] || context.pages()[0], step.expected);
      trace.push({ index, action: step.action, status: expectationResult.passed ? "succeeded" : "failed", durationMs: Date.now() - startedAt, observedUrl: last?.url, observedTitle: last?.title, observedPageGeneration: last?.pageGeneration, observedAccessibilityHash: last?.accessibilityHash, screenshotHash: last?.screenshotHash, progress, expectations: expectationResult.checks });
      previousKey = key;
      previousMarker = marker;
      if (!expectationResult.passed) {
        stoppedReason = "expectation_failed";
        break;
      }
      if (noProgressCount >= noProgressLimit) {
        stoppedReason = "no_progress";
        trace[trace.length - 1].status = "stopped";
        trace[trace.length - 1].recovery = "stop_and_reobserve";
        break;
      }
    } catch (error) {
      const message = String(error?.message || error);
      const recovery = /stale|fresh accessible|ambiguous|not found|timed out|timeout/i.test(message) ? "reobserve" : "stop";
      trace.push({ index, action: step.action, status: "failed", durationMs: Date.now() - startedAt, observedUrl: last?.url, observedTitle: last?.title, observedPageGeneration: last?.pageGeneration, observedAccessibilityHash: last?.accessibilityHash, screenshotHash: last?.screenshotHash, error: clean(message, 300), recovery });
      stoppedReason = "step_failed";
      if (recovery === "reobserve") {
        last = await execute(context, pageState, { action: "observe", includeForms: true, includeScreenshot: false }).catch(() => last);
      }
      break;
    }
  }
  const sequenceComplete = trace.length === steps.length && stoppedReason === "completed";
  if (sequenceComplete && Array.isArray(request.completionAssertions) && request.completionAssertions.length) {
    const completionPage = context.pages()[Math.max(0, Number(pageState.activeIndex || 0))] || context.pages()[0];
    const completionResult = completionPage
      ? await verifyAgentExpectations(completionPage, request.completionAssertions)
      : { passed: false, checks: [{ kind: "visible", value: "active browser page", required: true, passed: false }] };
    completionChecks = completionResult.checks;
    verified = completionResult.passed;
    if (!verified) stoppedReason = "completion_assertion_failed";
  }
  const safeLast = last && typeof last === "object" ? { ...last } : undefined;
  const screenshot = safeLast && typeof safeLast.screenshot === "string" ? { screenshot: safeLast.screenshot, screenshotHash: safeLast.screenshotHash, screenshotId: safeLast.screenshotId } : {};
  if (safeLast) delete safeLast.screenshot;
  const elapsedMs = Date.now() - startedRunAt;
  if (trace.length === steps.length && stoppedReason === "completed") stoppedReason = "completed";
  return result(context.pages()[Math.max(0, Number(pageState.activeIndex || 0))] || context.pages()[0], context, { agent: { steps: trace, completed: trace.length === steps.length && stoppedReason === "completed", verified, ...(completionChecks.length ? { completionChecks } : {}), maxSteps, maxActions, maxDurationMs, noProgressLimit, actionCount, elapsedMs, stoppedReason }, ...(safeLast ? { lastResult: safeLast } : {}), ...screenshot }, false);
}

async function execute(context, pageState, request) {
  let page = context.pages()[Math.max(0, Math.min(9, Number(pageState.activeIndex ?? 0)))] || context.pages()[0] || await context.newPage();
  if (request.action === "tab_open") page = await context.newPage();
  if (request.action === "tab_focus") page = context.pages()[Math.max(0, Number(request.index ?? 0))] || page;
  if (request.action === "tab_close") { if (context.pages().length > 1) await page.close(); page = context.pages()[0] || await context.newPage(); }
  if (request.currentUrl && (() => { try { return /^https?:$/.test(new URL(String(request.currentUrl)).protocol); } catch { return false; } })() && (!page.url() || page.url() === "about:blank")) await page.goto((await safeHttpUrl(request.currentUrl)).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  const action = request.action;
  let actionFormState;
  if (action === "diagnostics") { const pages = await Promise.all(context.pages().map(async (item, index) => ({ index, url: clean(item.url(), 1_000), title: clean(item.url() ? await item.title().catch(() => "") : "", 160), closed: item.isClosed() }))); return result(page, context, { diagnostics: { console: boundedRecords(diagnostics.console), errors: boundedRecords(diagnostics.errors), dialogs: boundedRecords(diagnostics.dialogs), pages }, events: boundedRecords(eventLog) }); }
  if (action === "events") return result(page, context, { events: boundedRecords(eventLog, 100) });
  if (action === "dialog_list") return result(page, context, { dialogs: boundedRecords(diagnostics.dialogs) });
  if (action === "dialog_dismiss") return result(page, context, { dismissed: true, dialogs: boundedRecords(diagnostics.dialogs) });
  if (action === "desktop_click") {
    if (typeof request.screenshotHash !== "string" || request.visualFallback !== true) throw new Error("Desktop coordinate clicks require a fresh screenshotHash and visualFallback=true");
    const currentShot = await page.screenshot({ type: "jpeg", quality: 75 });
    const currentHash = createHash("sha256").update(currentShot).digest("hex").slice(0, 32);
    if (currentHash !== request.screenshotHash) throw new Error("Visual target is stale; capture a fresh screenshot before retrying the desktop click");
    await page.mouse.click(Number(request.x), Number(request.y), { button: request.button === "right" ? "right" : request.button === "middle" ? "middle" : "left", clickCount: request.double === true ? 2 : 1 });
    return result(page, context, { desktopAction: "click" });
  }
  if (action === "desktop_type") { await page.keyboard.type(String(request.text || ""), { delay: Math.max(0, Math.min(250, Number(request.delayMs || 0))) }); return result(page, context, { desktopAction: "type" }); }
  if (action === "desktop_press") { await page.keyboard.press(String(request.key || request.keys || "Enter")); return result(page, context, { desktopAction: "press" }); }
  if (action === "clipboard_write") { const text = String(request.text || ""); if (text.length > 8_000) throw new Error("Clipboard text exceeds the 8 KB limit"); await page.evaluate(async (value) => { await navigator.clipboard.writeText(value); }, text); return result(page, context, { clipboard: "written", length: text.length }); }
  if (action === "clipboard_read") { const text = await page.evaluate(async () => navigator.clipboard.readText()); return result(page, context, { clipboard: "read", text: clean(text, 8_000) }); }
  if (action === "pdf") {
    const id = randomUUID(); const filePath = `${DOWNLOAD_ROOT}/${id}.pdf`; const cdp = await context.newCDPSession(page); const output = await cdp.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true }); await fs.writeFile(filePath, Buffer.from(output.data, "base64")); const stat = await fs.stat(filePath); return result(page, context, { pdf: { filePath, name: `${safeFileName(await page.title().catch(() => "page")) || "page"}.pdf`, size: stat.size } });
  }
  const mutationAction = ["click", "invoke", "fill", "select_option", "check", "uncheck", "type", "press", "form_fill", "act", "agent"].includes(action);
  const beforeAction = mutationAction ? { url: page.url(), title: await page.title().catch(() => ""), generation: await pageGeneration(page) } : undefined;
  const target = request.selector ? await resolveLocator(page, request.selector) : null;
  if (action === "open") {
    const requestedWaitUntil = ["commit", "domcontentloaded", "load", "networkidle"].includes(String(request.waitUntil)) ? String(request.waitUntil) : "domcontentloaded";
    await page.goto((await safeHttpUrl(request.url)).toString(), { waitUntil: requestedWaitUntil, timeout: 45_000 });
    if (requestedWaitUntil === "commit") await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
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
  else if (action === "observe") {
    const observed = { matches: await roleMatches(page, request), forms: request.includeForms === false ? undefined : await inspectForms(page) };
    if (request.includeLinks === true) observed.links = await linkMatches(page);
    if (request.includeScreenshot === true) {
      const image = await page.screenshot({ type: "jpeg", quality: 75 });
      observed.screenshot = image.toString("base64");
      observed.screenshotHash = createHash("sha256").update(image).digest("hex").slice(0, 32);
    }
    return result(page, context, observed, request.includePageContent === true);
  } else if (action === "extract") {
    const extracted = await extractRequestedSchema(page, request.schema || {});
    return result(page, context, extracted, request.includePageContent === true);
  } else if (action === "act") {
    if (!request.step || typeof request.step !== "object") throw new Error("act requires one browser step");
    return execute(context, pageState, request.step);
  } else if (action === "agent") return boundedAgentRun(context, pageState, request);
  else if (action === "form_inspect") return result(page, context, { forms: await inspectForms(page) }, request.includePageContent === true);
  else if (action === "form_fill") {
    const completedControls = [];
    const pendingControls = [];
    const actionErrors = [];
    for (const control of Array.isArray(request.controls) ? request.controls.slice(0, 100) : []) {
      const label = clean(control?.label || control?.name || "form control", 200);
      try { await applyFormControl(page, control); completedControls.push(label); }
      catch (error) { pendingControls.push(label); actionErrors.push({ label, message: clean(error?.message || error, 300) }); }
    }
    const forms = await inspectForms(page);
    const validationErrors = forms.flatMap((form) => form.controls.filter((control) => control.invalid).map((control) => ({ label: control.name, message: control.validationMessage || "The field is invalid" })));
    let submitted = false;
    if (request.submit === true && !actionErrors.length && !validationErrors.length && request.submitControl) {
      try { const submitLocator = await resolveLocator(page, request.submitControl); await clickControl(page, submitLocator); submitted = true; }
      catch (error) { actionErrors.push({ label: clean(request.submitControl.name || "Submit", 200), message: clean(error?.message || error, 300) }); }
    }
    const allErrors = [...actionErrors, ...validationErrors];
    const workflowCheckpoint = { action: "form_fill", formId: clean(request.formId || "", 160), completedControls, pendingControls: [...pendingControls, ...validationErrors.map((item) => item.label)], validationErrors: allErrors, nextAction: submitted ? "Inspect and verify the submitted result" : allErrors.length ? "Correct the reported validation errors, then retry the pending controls" : "Review the filled form and submit only after the required fields are verified" };
    const afterUrl = page.url();
    const afterTitle = await page.title().catch(() => "");
    const afterGeneration = await pageGeneration(page);
    const actionVerification = beforeAction ? { attempted: true, observed: true, urlChanged: beforeAction.url !== afterUrl, titleChanged: beforeAction.title !== afterTitle, pageGenerationChanged: beforeAction.generation !== afterGeneration, validationErrors: allErrors } : undefined;
    return result(page, context, { matches: await roleMatches(page), forms, workflowCheckpoint, ...(allErrors.length ? { validationErrors: allErrors } : {}), submitted, ...(actionVerification ? { actionVerification } : {}) }, request.includePageContent === true);
  }
  else if (action === "health") return result(page, context, { health: { status: "ready", daemon: "ready", chromium: page.isClosed() ? "closed" : "ready", pages: context.pages().length, display: DISPLAY, profile: PROFILE } });
  else if ((action === "click" || action === "move") && Number.isFinite(Number(request.x)) && Number.isFinite(Number(request.y))) {
    if (action === "click" && request.visualFallback === true) {
      if (typeof request.screenshotHash !== "string" || !request.screenshotHash) throw new Error("Visual coordinate clicks require a screenshotHash from a fresh screenshot");
      const currentShot = await page.screenshot({ type: "jpeg", quality: 75 });
      const currentHash = createHash("sha256").update(currentShot).digest("hex").slice(0, 32);
      if (currentHash !== request.screenshotHash) throw new Error("Visual target is stale; capture a fresh screenshot before retrying the coordinate click");
    }
    if (action === "click") await page.mouse.click(Number(request.x), Number(request.y));
    else await page.mouse.move(Number(request.x), Number(request.y));
  } else if (["invoke", "click", "focus", "fill", "move", "hover", "select_option", "check", "uncheck"].includes(action)) {
    if (!target) throw new Error("This browser action requires a fresh accessible node selector");
    await target.waitFor({ state: "attached", timeout: 10_000 });
    if (["invoke", "click"].includes(action)) await clickControl(page, target);
    if (["move", "hover"].includes(action)) await target.hover({ timeout: 15_000 });
    if (action === "focus") await target.focus();
    if (action === "fill") {
      const value = String(request.value ?? request.text ?? "");
      actionFormState = await fillControl(page, target, value, frameFor(page, request.selector));
    }
    if (action === "select_option") actionFormState = await selectControl(page, target, request.value ?? "", frameFor(page, request.selector));
    if (action === "check") actionFormState = await setCheckbox(target, true);
    if (action === "uncheck") actionFormState = await setCheckbox(target, false);
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
  else if (action === "drag") { if (!request.source || !request.target) throw new Error("drag requires source and target accessible selectors"); await (await resolveLocator(page, request.source)).dragTo(await resolveLocator(page, request.target), { timeout: 15_000 }); }
  else if (action === "scroll") await page.mouse.wheel(0, (request.direction === "up" ? -1 : 1) * Math.max(1, Math.min(10, Number(request.amount || 3))) * 600);
  else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  else if (action === "refresh") await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  else if (action === "wait") {
    const timeoutMs = Math.max(50, Math.min(30_000, Number(request.timeoutMs ?? 1_000)));
    if (request.role || request.name) {
      const semanticTarget = await resolveLocator(page, request);
      await semanticTarget.waitFor({ state: "visible", timeout: timeoutMs });
    } else await page.waitForTimeout(timeoutMs);
  }
  else if (["screenshot", "screenshot_full", "screenshot_region", "screenshot_region_full"].includes(action)) {
    const clipped = ["screenshot_region", "screenshot_region_full"].includes(action);
    const clip = clipped && [request.x, request.y, request.width, request.height].every((value) => Number.isFinite(Number(value))) ? { x: Number(request.x), y: Number(request.y), width: Number(request.width), height: Number(request.height) } : undefined;
    const image = await page.screenshot({ type: "jpeg", quality: 75, fullPage: action === "screenshot_full", ...(clip ? { clip } : {}) });
    const encoded = image.toString("base64");
    return result(page, context, { screenshot: encoded, screenshotId: randomUUID(), screenshotHash: createHash("sha256").update(image).digest("hex").slice(0, 32), screenshotCapturedAt: Date.now() });
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
  const formState = target && ["fill", "select_option", "check", "uncheck"].includes(action) ? await controlState(target) : undefined;
  const reportedFormState = formState ? { ...formState, ...(actionFormState || {}) } : actionFormState;
  const formMutation = ["fill", "select_option", "check", "uncheck", "click", "press"].includes(action);
  const afterUrl = page.url();
  const afterTitle = await page.title().catch(() => "");
  const afterGeneration = await pageGeneration(page);
  const actionVerification = beforeAction ? { attempted: true, observed: true, urlChanged: beforeAction.url !== afterUrl, titleChanged: beforeAction.title !== afterTitle, pageGenerationChanged: beforeAction.generation !== afterGeneration } : undefined;
  return result(page, context, { matches: await roleMatches(page), ...(reportedFormState ? { formState: reportedFormState } : {}), ...(formMutation ? { forms: await inspectForms(page) } : {}), ...(actionVerification ? { actionVerification } : {}) }, request.includePageContent === true);
}

async function vaultLogin(context, request) {
  const pages = context.pages();
  const requestedIndex = Number(request.activeIndex);
  const page = Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < pages.length
    ? pages[requestedIndex]
    : pages[0] || await context.newPage();
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
  let geolocation;
  try { const parsed = JSON.parse(process.env.CHUSKY_BROWSER_GEOLOCATION || ""); if (Number.isFinite(parsed?.latitude) && Number.isFinite(parsed?.longitude)) geolocation = { latitude: Number(parsed.latitude), longitude: Number(parsed.longitude), ...(Number.isFinite(parsed.accuracy) ? { accuracy: Number(parsed.accuracy) } : {}) }; } catch {}
  const browserArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"];
  // Keep the headed Chromium feature surface intact for normal websites and
  // human-only challenges. Operators can opt back into software-only rendering
  // for constrained hosts, but it must be explicit rather than silently making
  // every browser session look unusual to sites that depend on WebGL/canvas.
  if (process.env.CHUSKY_BROWSER_DISABLE_GPU === "true") browserArgs.push("--disable-gpu");
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"], locale: process.env.CHUSKY_BROWSER_LOCALE || "en-US", timezoneId: process.env.CHUSKY_BROWSER_TIMEZONE || "America/New_York", ...(geolocation ? { geolocation } : {}), args: browserArgs, viewport: { width: 1440, height: 900 }, env: browserEnv });
  await fs.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(RECORDING_ROOT, { recursive: true, mode: 0o700 });
  context.on("page", (page) => {
    ensurePageTracking(page);
    recordEvent("page_created", { url: clean(page.url(), 1_000) });
    attachDownloadListener(page);
    void interceptPageRequests(context, page);
  });
  for (const page of context.pages()) {
    ensurePageTracking(page);
    attachDownloadListener(page);
    await interceptPageRequests(context, page);
  }
  if (!context.pages().length) await context.newPage();
  const pageState = { activeIndex: 0 };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/health") { const health = await healthSnapshot(context); response.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" }); response.end(JSON.stringify(health)); return; }
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
          output = await runSmokeFixture(context, pageState);
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
