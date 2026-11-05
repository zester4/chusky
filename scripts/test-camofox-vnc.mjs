/**
 * Probe Camofox's VNC status and public viewer URLs while a browser is active.
 * Run with: node scripts/test-camofox-vnc.mjs
 *
 * This verifies reachability only; it does not prove that a viewer is private
 * or isolated to the requesting user.
 */
import { randomUUID } from "node:crypto";
import { ACCESS_KEY, BASE, NOVNC_BASE } from "./camofox-config.mjs";

const userId = `thinky-vnc-probe-${randomUUID()}`;
const sessionKey = `vnc-probe-${randomUUID()}`;
const targetUrl = "https://example.com/";
let tabId;
let failed = false;

function getNovncBase() {
  if (!NOVNC_BASE) {
    throw new Error("Missing CAMOFOX_NOVNC_URL. Set it to the separate public HTTPS noVNC origin.");
  }

  let url;
  try {
    url = new URL(NOVNC_BASE);
  } catch {
    throw new Error("CAMOFOX_NOVNC_URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CAMOFOX_NOVNC_URL must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  if (url.origin === new URL(BASE).origin) {
    throw new Error("CAMOFOX_NOVNC_URL must use the separate noVNC Railway domain, not the Camofox API domain.");
  }
  return url.origin;
}

async function request(pathOrUrl, { method = "GET", body, authenticate = true, timeout = 20_000 } = {}) {
  const url = new URL(pathOrUrl, BASE);
  const isBrowserApi =
    url.pathname === "/tabs" ||
    url.pathname.startsWith("/tabs/") ||
    url.pathname.startsWith("/sessions/");
  if (isBrowserApi && !url.searchParams.has("userId")) {
    url.searchParams.set("userId", userId);
  }

  const response = await fetch(url, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: {
      Accept: "application/json, text/html",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(authenticate ? { Authorization: `Bearer ${ACCESS_KEY}` } : {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { response, text, data, url };
}

function safeBody(text) {
  return text
    .replaceAll(ACCESS_KEY, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

function report(label, result) {
  console.log(`${label}: HTTP ${result.response.status}`);
  if (result.data !== undefined) {
    console.log(JSON.stringify(result.data));
  } else if (result.text) {
    console.log(safeBody(result.text));
  }
}

async function checkViewer(label, url) {
  try {
    const result = await request(url, { authenticate: false, timeout: 8_000 });
    console.log(
      `${label}: HTTP ${result.response.status}; content-type ${result.response.headers.get("content-type") ?? "(none)"}`,
    );
    if (result.response.ok) {
      const isNovncPage = /noVNC|novnc|websockify/i.test(result.text);
      console.log(`Contains noVNC markers: ${isNovncPage}`);
      if (!isNovncPage) failed = true;
    } else if (result.text) {
      console.log(`Response body: ${safeBody(result.text)}`);
      failed = true;
    } else {
      failed = true;
    }
    return result.response.ok;
  } catch (error) {
    console.error(`${label}: request failed (${error.cause?.code ?? error.name})`);
    failed = true;
    return false;
  }
}

async function cleanup() {
  if (tabId) {
    try {
      const result = await request(`/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
      console.log(`Temporary tab cleanup: HTTP ${result.response.status}`);
      if (!result.response.ok) failed = true;
    } catch (error) {
      failed = true;
      console.error(`Could not close the temporary tab: ${error.message}`);
    }
  }

  try {
    const result = await request(`/sessions/${encodeURIComponent(userId)}`, { method: "DELETE" });
    console.log(`Temporary session cleanup: HTTP ${result.response.status}`);
    if (!result.response.ok) failed = true;
  } catch (error) {
    failed = true;
    console.error(`Could not delete the temporary session: ${error.message}`);
  }
}

try {
  const novncBase = getNovncBase();

  console.log("Checking /health without an access key...");
  const health = await request("/health", { authenticate: false });
  report("/health without key", health);
  if (health.response.status !== 200) failed = true;

  console.log("Opening a temporary example.com tab...");
  const opened = await request("/tabs", {
    method: "POST",
    body: { userId, sessionKey, url: targetUrl },
  });
  report("Open temporary tab", opened);
  tabId = opened.data?.tabId;
  if (!opened.response.ok || typeof tabId !== "string" || tabId.length === 0) {
    throw new Error("Could not open a temporary browser tab.");
  }

  console.log("Checking /vnc/status without a key (expected HTTP 401)...");
  const vncPublic = await request("/vnc/status", { authenticate: false });
  report("/vnc/status without key", vncPublic);
  if (vncPublic.response.status !== 401) failed = true;

  console.log("Checking /vnc/status with the configured access key...");
  const vnc = await request("/vnc/status");
  report("/vnc/status with key", vnc);
  if (!vnc.response.ok || typeof vnc.data?.path !== "string") {
    failed = true;
    throw new Error("The authenticated VNC status response did not include a viewer path.");
  }

  const viewerPath = vnc.data.path;
  if (!viewerPath.startsWith("/")) {
    failed = true;
    throw new Error("The VNC viewer path is not a same-origin absolute path.");
  }
  const viewerUrl = new URL(viewerPath, novncBase).toString();
  console.log(`Checking viewer on the separate noVNC domain: ${viewerUrl}`);
  const viewerReachable = await checkViewer("noVNC viewer", viewerUrl);
  if (viewerReachable) {
    console.log("Warning: the noVNC display may be shared across users. Do not share the URL unless access is restricted and isolation is verified.");
  }

  if (vnc.data.running !== true) {
    console.error("VNC status says the viewer is not running while the test tab is open.");
    failed = true;
  }
} catch (error) {
  failed = true;
  console.error(`VNC probe failed: ${error.message}`);
} finally {
  await cleanup();
}

if (failed) {
  process.exitCode = 1;
  console.error("VNC probe found one or more failures. Viewer reachability does not establish user isolation.");
} else {
  console.log("VNC endpoints responded; verify viewer access is user-isolated before sharing any URL.");
}