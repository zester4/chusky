import "dotenv/config";
import { randomInt } from "node:crypto";
import { config } from "../src/config.js";
import { E2BBrowserEngine } from "../src/lib/e2b/browser.js";
import { kernelClient, kernelTimeoutSeconds, kernelConfigurationStatus } from "../src/lib/e2b/kernel.js";
import { getSession, initStore } from "../src/store.js";

async function main() {
  const configured = Boolean(config.e2bEnabled && config.e2bApiKey && config.kernelApiKey && config.e2bBrowserTemplate);
  kernelTimeoutSeconds();
  console.log(JSON.stringify({ configured, configurationStatus: kernelConfigurationStatus(), provider: config.browserProvider, e2bEnabled: config.e2bEnabled, e2bKeyPresent: Boolean(config.e2bApiKey), kernelKeyPresent: Boolean(config.kernelApiKey), templateRebuildRequired: true, liveRequested: process.argv.includes("--live") }));
  if (!process.argv.includes("--live")) return;
  if (!configured) throw new Error("Kernel smoke requires E2B_ENABLED, E2B_API_KEY, KERNEL_API_KEY and a rebuilt browser template");
  // Disposable synthetic owner, memory-only store: never attach a real user's profile.
  await initStore({ memoryOnly: true, suppressStorageMetrics: true });
  config.browserProvider = "kernel";
  const owner = randomInt(1_000_000_000, 2_000_000_000);
  const engine = new E2BBrowserEngine();
  const invoke = (action: string, args: Record<string, unknown> = {}) => engine.browser(owner, { action, ...args }, { ownerPrivateRun: true });
  try {
    await invoke("start");
    const opened = await invoke("open", { url: "https://example.com" }) as { provider?: string; observedUrl?: string; title?: string };
    if (opened.provider !== "kernel" || opened.observedUrl !== "https://example.com/" || opened.title !== "Example Domain") throw new Error("Public-page verification failed");
    const viewer = await invoke("stream_start") as { url?: string };
    if (!viewer.url) throw new Error("Private live view unavailable");
    await invoke("observe", { includeScreenshot: true });
    console.log(JSON.stringify({ pageVerified: true, liveViewAvailable: true, observationsAvailable: true, captchaVerified: false, managedAuthVerified: false }));
  } finally {
    const profile = (await getSession(owner)).kernelBrowserProfileId;
    await invoke("stop");
    if (profile) await kernelClient().profiles.delete(profile);
    console.log(JSON.stringify({ disposableResourcesClosed: true }));
  }
}

main().catch(() => {
  // Provider exception bodies and bearer URLs must not enter logs.
  console.error("Kernel browser check failed. Verify configuration, template and provider availability; retained resource references may require cleanup.");
  process.exitCode = 1;
});
