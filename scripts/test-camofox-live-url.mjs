/**
 * Check whether the configured Camofox service returns a live viewer URL.
 * Run from anywhere with: node scripts/test-camofox-live-url.mjs
 */
import { randomUUID } from "node:crypto";
import { ACCESS_KEY, BASE } from "./camofox-config.mjs";

const USER_ID = `thinky-live-url-probe-${randomUUID()}`;
const SESSION_KEY = `probe-${randomUUID()}`;
const TARGET_URL = "https://example.com/";
const TIMEOUT_MS = 20_000;
const VIEWER_FIELD = /live.?view|viewer|no.?vnc|vnc.?url|remote.?view/i;

async function request(path, options = {}, userId) {
  const url = new URL(path, BASE);
  if (userId) {
    url.searchParams.set("userId", userId);
  }

  const fetchOptions = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      Accept: "application/json",
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${ACCESS_KEY}`,
      ...fetchOptions.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`Camofox returned HTTP ${response.status} for ${path}.`);
  }

  return data;
}

function findViewerUrls(value, path = "$", results = []) {
  if (!value || typeof value !== "object") {
    return results;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (VIEWER_FIELD.test(key) && typeof child === "string") {
      try {
        const url = new URL(child, BASE);
        if (url.protocol === "https:" || url.protocol === "http:") {
          url.username = "";
          url.password = "";
          for (const key of url.searchParams.keys()) {
            if (/token|secret|key|auth|password|session|signature/i.test(key)) {
              url.searchParams.set(key, "[REDACTED]");
            }
          }
          if (url.hash) {
            url.hash = "#[REDACTED]";
          }
          results.push({ field: childPath, url: url.toString() });
        }
      } catch {
        // Ignore fields that look relevant but aren't URLs.
      }
    } else if (child && typeof child === "object") {
      findViewerUrls(child, childPath, results);
    }
  }

  return results;
}

async function cleanup(tabId) {
  if (tabId) {
    try {
      await request(`/tabs/${encodeURIComponent(tabId)}`, {
        method: "DELETE",
      }, USER_ID);
      console.log("Temporary tab cleaned up.");
    } catch (error) {
      console.error(`Could not close the temporary tab: ${error.message}`);
    }
  }

  try {
    await request(`/sessions/${encodeURIComponent(USER_ID)}`, {
      method: "DELETE",
    });
    console.log("Temporary browser session cleaned up.");
  } catch (error) {
    console.error(`Could not delete the temporary session: ${error.message}`);
  }
}

async function main() {
  let tabId;
  let failed = false;
  const viewerUrls = [];

  try {
    console.log("Checking Camofox health and browser-open response...");
    const health = await request("/health");
    viewerUrls.push(...findViewerUrls(health, "$.health"));

    const tab = await request("/tabs", {
      method: "POST",
      body: JSON.stringify({
        userId: USER_ID,
        sessionKey: SESSION_KEY,
        url: TARGET_URL,
      }),
    }, USER_ID);

    if (tab && typeof tab === "object" && typeof tab.tabId === "string") {
      tabId = tab.tabId;
    }
    viewerUrls.push(...findViewerUrls(tab, "$.openTab"));

    if (viewerUrls.length > 0) {
      console.log("Camofox returned possible live-view URL field(s):");
      for (const result of viewerUrls) {
        console.log(`- ${result.field}: ${result.url}`);
      }
      console.log("Verify that a discovered URL is private and scoped to this user before sharing it.");
    } else {
      console.log("No live-view URL was returned in the health or open-tab response.");
      console.log("This probe did not find a per-user viewer URL; it does not test undocumented URL patterns.");
    }

    if (!tabId) {
      throw new Error("The browser service did not return a tabId; could not verify cleanup.");
    }
  } catch (error) {
    failed = true;
    console.error(`Live-view probe failed: ${error.message}`);
  } finally {
    await cleanup(tabId);
  }

  if (failed) {
    process.exitCode = 1;
  } else if (viewerUrls.length === 0) {
    console.log("Result: live viewer URL is not exposed by the tested responses.");
  } else {
    console.log("Result: viewer URL field(s) are present; confirm the links are user-isolated before use.");
  }
}

await main();