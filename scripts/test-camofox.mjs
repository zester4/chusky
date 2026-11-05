/**
 * Safely smoke-test browser actions and optional search macros.
 * Run with: node scripts/test-camofox.mjs [--macro @google_search | --macros] [--timeout-ms 30000]
 */
import { randomUUID } from "node:crypto";
import { ACCESS_KEY, BASE } from "./camofox-config.mjs";

const MACROS = [
  "@google_search",
  "@youtube_search",
  "@amazon_search",
  "@reddit_search",
  "@reddit_subreddit",
  "@wikipedia_search",
  "@twitter_search",
  "@yelp_search",
  "@spotify_search",
  "@netflix_search",
  "@linkedin_search",
  "@instagram_search",
  "@tiktok_search",
  "@twitch_search",
];
const TARGET_URL = "https://example.com/";
const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(args) {
  let macros = [];
  let macroModeSelected = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--macros") {
      if (macroModeSelected) throw new Error("Choose either --macro or --macros, not both.");
      macroModeSelected = true;
      macros = MACROS;
    } else if (arg === "--macro") {
      if (macroModeSelected) throw new Error("Choose either --macro or --macros, not both.");
      macroModeSelected = true;
      const macro = args[++index];
      if (!MACROS.includes(macro)) {
        throw new Error(`Unknown macro. Choose one of: ${MACROS.join(", ")}`);
      }
      macros = [macro];
    } else if (arg === "--timeout-ms") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1000 || value > 120_000) {
        throw new Error("--timeout-ms must be an integer from 1000 to 120000.");
      }
      timeoutMs = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { macros, timeoutMs };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error("Usage: node scripts/test-camofox.mjs [--macro @google_search | --macros] [--timeout-ms 30000]");
  process.exit(2);
}

const userId = `thinky-browser-test-${randomUUID()}`;
const sessionKey = `browser-test-${randomUUID()}`;
const tabIds = new Set();
let failed = false;

async function request(path, { method = "GET", body, authenticate = true, timeoutMs } = {}) {
  const url = new URL(path, BASE);
  if (!url.searchParams.has("userId") && path !== "/health") {
    url.searchParams.set("userId", userId);
  }

  const requestTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(authenticate ? { Authorization: "Bearer " + ACCESS_KEY } : {}),
      },
      redirect: "error",
      signal: timeoutSignal,
    });
    text = await response.text();
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error(`Camofox request timed out after ${requestTimeoutMs}ms for ${path}.`);
    }
    throw error;
  }

  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`Camofox returned HTTP ${response.status} for ${path}.`);
  }
  return data;
}

async function openTab(key, timeoutMs) {
  const tab = await request("/tabs", {
    method: "POST",
    body: { userId, sessionKey: key, url: TARGET_URL },
    timeoutMs,
  });
  if (typeof tab?.tabId !== "string" || tab.tabId.length === 0) {
    throw new Error("Camofox did not return a tab ID.");
  }
  tabIds.add(tab.tabId);
  return tab.tabId;
}

async function closeTab(id) {
  await request(`/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
  tabIds.delete(id);
}

async function cleanup() {
  for (const id of tabIds) {
    try {
      await closeTab(id);
      console.log("Temporary tab closed.");
    } catch (error) {
      failed = true;
      console.error(`Could not close the temporary tab: ${error.message}`);
    }
  }

  try {
    await request(`/sessions/${encodeURIComponent(userId)}`, { method: "DELETE" });
    console.log("Temporary browser session deleted.");
  } catch (error) {
    failed = true;
    console.error(`Could not delete the temporary session: ${error.message}`);
  }
}

try {
  console.log("Checking Camofox health...");
  await request("/health", { authenticate: false });

  console.log("Opening a temporary example.com tab...");
  const tabId = await openTab(sessionKey);

  console.log("Navigating to example.com...");
  await request(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
    method: "POST",
    body: { userId, url: TARGET_URL },
  });

  console.log("Taking an accessibility snapshot...");
  const snapshot = await request(`/tabs/${encodeURIComponent(tabId)}/snapshot`);
  if (typeof snapshot?.snapshot !== "string" || !snapshot.url.includes("example.com")) {
    throw new Error("Camofox returned an unexpected snapshot for example.com.");
  }
  console.log(`Snapshot received for ${snapshot.url} (${snapshot.refsCount ?? "unknown"} refs).`);
  console.log(snapshot.snapshot.slice(0, 500));

  if (options.macros.length > 0) {
    console.log(`Testing ${options.macros.length} search macro${options.macros.length === 1 ? "" : "s"}...`);
    for (const macro of options.macros) {
      let macroTabId;
      const query = macro === "@reddit_subreddit" ? "technology" : "IANA example domains";
      try {
        macroTabId = await openTab(`browser-macro-${randomUUID()}`, options.timeoutMs);
        const before = await request(`/tabs/${encodeURIComponent(macroTabId)}/snapshot`, {
          timeoutMs: options.timeoutMs,
        });
        const result = await request(`/tabs/${encodeURIComponent(macroTabId)}/navigate`, {
          method: "POST",
          body: { userId, macro, query },
          timeoutMs: options.timeoutMs,
        });
        if (result?.ok === false) {
          throw new Error("Camofox reported that navigation failed.");
        }

        const after = await request(`/tabs/${encodeURIComponent(macroTabId)}/snapshot`, {
          timeoutMs: options.timeoutMs,
        });
        if (
          typeof after?.url !== "string" ||
          after.url === before?.url ||
          typeof after.snapshot !== "string" ||
          after.snapshot.trim().length === 0
        ) {
          throw new Error("The macro did not navigate to a page with a readable snapshot.");
        }
        console.log(`PASS ${macro} (${after.url})`);
      } catch (error) {
        failed = true;
        console.error(`FAIL ${macro}: ${error.message}`);
      } finally {
        if (macroTabId) {
          try {
            await closeTab(macroTabId);
          } catch (error) {
            failed = true;
            console.error(`Could not close the ${macro} test tab: ${error.message}`);
          }
        }
      }
    }
  }
} catch (error) {
  failed = true;
  console.error(`Browser smoke test failed: ${error.message}`);
} finally {
  await cleanup();
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("Browser smoke test passed.");
}