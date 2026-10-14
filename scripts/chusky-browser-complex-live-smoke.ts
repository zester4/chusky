import "dotenv/config";
import { randomInt } from "node:crypto";
import { config } from "../src/config.js";
import { E2BBrowserEngine } from "../src/lib/e2b/browser.js";
import { kernelClient } from "../src/lib/e2b/kernel.js";
import { getSession, initStore } from "../src/store.js";

type BrowserResult = Record<string, unknown> & {
  matches?: Array<Record<string, unknown>>;
  tabs?: Array<Record<string, unknown>>;
  screenshotHash?: string;
  url?: string;
  observedUrl?: string;
  title?: string;
  accessibilityHash?: string;
  text?: string;
  pageContent?: string;
  wait?: { conditioned?: boolean; matched?: string[] };
};

const TODO_URL = "https://demo.playwright.dev/todomvc/";

function matchSummary(result: BrowserResult) {
  return (result.matches ?? []).map((match) => ({
    role: typeof match.role === "string" ? match.role : "unknown",
    name: typeof match.name === "string" ? match.name.slice(0, 100) : "",
    frameIndex: Number.isSafeInteger(Number(match.frameIndex)) ? Number(match.frameIndex) : 0,
  }));
}

function smokeError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 300)
    : "unknown error";
}

async function main() {
  const configured = Boolean(config.e2bEnabled && config.e2bApiKey && config.kernelApiKey && config.e2bBrowserTemplate);
  if (!configured) throw new Error("Complex Kernel smoke requires E2B_ENABLED, E2B_API_KEY, KERNEL_API_KEY and a rebuilt browser template");
  await initStore({ memoryOnly: true, suppressStorageMetrics: true });
  config.browserProvider = "kernel";
  config.kernelBrowserOptIn = true;
  const owner = randomInt(2_000_000_000, 2_100_000_000);
  const engine = new E2BBrowserEngine();
  const invoke = (action: string, args: Record<string, unknown> = {}) => engine.browser(owner, { action, ...args }, { ownerPrivateRun: true, visualFeedback: true });
  const tests: Array<Record<string, unknown>> = [];
  let phase = "start";

  try {
    phase = "start";
    await invoke("start");
    phase = "todo-open";
    const todoOpen = await invoke("open", { url: TODO_URL }) as BrowserResult;
    console.log(JSON.stringify({ phase, observedUrl: todoOpen.observedUrl, title: todoOpen.title }));
    phase = "todo-wait-for-render";
    const todoWait = await invoke("wait", { urlIncludes: "demo.playwright.dev", timeoutSeconds: 5 }) as BrowserResult;
    phase = "todo-observe";
    const todoObserved = await invoke("observe", { includeForms: true }) as BrowserResult;
    tests.push({
      id: "spa-observation",
      opened: todoOpen.observedUrl?.includes("demo.playwright.dev/todomvc") === true,
      conditionWait: todoWait.wait?.conditioned === true,
      observed: Boolean(todoObserved.accessibilityHash),
      structuredControls: matchSummary(todoObserved).length,
      screenshotEvidence: Boolean(todoObserved.screenshotHash),
    });

    phase = "selenium-form-open";
    const formOpen = await invoke("open", { url: "https://www.selenium.dev/selenium/web/web-form.html" }) as BrowserResult;
    phase = "selenium-form-observe";
    const formObserved = await invoke("observe", { includeForms: true }) as BrowserResult;
    phase = "selenium-form-submit";
    const formResult = await invoke("form_fill", { fields: [{ label: "Text input", value: "validated by Chusky Browser" }], submit: true }) as BrowserResult;
    phase = "selenium-form-wait-for-submit";
    const submittedWait = await invoke("wait", { urlIncludes: "submitted-form", textIncludes: "Received!", timeoutSeconds: 5 }) as BrowserResult;
    phase = "selenium-form-verify";
    const submitted = await invoke("observe", { includeForms: false, includePageContent: true }) as BrowserResult;
    const submittedText = typeof submitted.pageContent === "string" ? submitted.pageContent : "";
    const formVerified = submitted.observedUrl?.includes("submitted-form") === true || submittedText.includes("Received!");
    if (!formVerified) throw new Error("Selenium web form did not expose an independent submitted-state detector");
    tests.push({ id: "form-submit", opened: formOpen.observedUrl?.includes("web-form.html") === true, observed: Boolean(formObserved.forms), plannerReturned: Boolean(formResult.checkpoint || formResult.workflowCheckpoint), conditionWait: submittedWait.wait?.conditioned === true, mutationVerified: formVerified, screenshotEvidence: Boolean(submitted.screenshotHash) });

    phase = "tab-open";
    const tabOpened = await invoke("tab_open") as BrowserResult;
    phase = "tab-navigate";
    await invoke("open", { url: "https://example.com" });
    phase = "tab-list";
    const tabs = await invoke("tabs") as BrowserResult;
    const tabCount = Array.isArray(tabs.tabs) ? tabs.tabs.length : 0;
    if (tabCount < 2) throw new Error("A second browser tab was not created and observed");
    phase = "tab-close";
    await invoke("tab_close");
    tests.push({ id: "popup-target", tabOpened: Array.isArray(tabOpened.tabs), tabCountBeforeClose: tabCount, closed: true });

    phase = "stream-start";
    const viewer = await invoke("stream_start") as BrowserResult;
    tests.push({ id: "live-view", available: typeof viewer.url === "string" || typeof (viewer as { stream?: { url?: unknown } }).stream?.url === "string" });
    phase = "diagnostics";
    const diagnostics = await invoke("diagnostics") as BrowserResult;
    tests.push({ id: "diagnostics", returned: Boolean(diagnostics.diagnostics) });
    console.log(JSON.stringify({
      provider: "kernel",
      complexBrowserEvidence: tests,
      screenshotEvidenceAvailable: tests.some((item) => item.screenshotEvidence === true),
      challengeVerified: false,
      managedAuthVerified: false,
    }));
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    console.error(JSON.stringify({ complexSmokeFailed: true, phase, errorType: error instanceof Error ? error.name : "unknown", errorCode: code, errorMessage: smokeError(error) }));
    throw error;
  } finally {
    const profile = (await getSession(owner)).kernelBrowserProfileId;
    await invoke("stop").catch(() => undefined);
    if (profile) await kernelClient().profiles.delete(profile).catch(() => undefined);
    console.log(JSON.stringify({ disposableResourcesClosed: true }));
  }
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  console.error(JSON.stringify({ complexSmokeFailed: true, phase: "redacted-by-entrypoint", errorType: error instanceof Error ? error.name : "unknown", errorCode: code, errorMessage: smokeError(error) }));
  process.exitCode = 1;
});
