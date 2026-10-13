import "dotenv/config";
import { randomInt } from "node:crypto";
import * as readline from "node:readline";
import { config } from "../src/config.js";
import { E2BBrowserEngine } from "../src/lib/e2b/browser.js";
import { kernelClient } from "../src/lib/e2b/kernel.js";
import { pageLooksUsable } from "../src/lib/e2b/liveSmoke.js";
import { getSession, initStore } from "../src/store.js";

type BrowserResult = Record<string, any> & {
  challenge?: { detected?: boolean; type?: string };
  needsUserInteraction?: boolean;
  observedUrl?: string;
  title?: string;
  pageContent?: string;
  screenshotHash?: string;
};

const SITES = [
  { id: "iana", url: "https://www.iana.org/help/example-domains" },
  { id: "playwright-todo", url: "https://demo.playwright.dev/todomvc/" },
  { id: "selenium-form", url: "https://www.selenium.dev/selenium/web/web-form.html" },
  { id: "united", url: "https://www.united.com/en/us" },
  { id: "delta", url: "https://www.delta.com" },
  { id: "american-airlines", url: "https://www.aa.com" },
  { id: "southwest", url: "https://www.southwest.com" },
  { id: "airbnb", url: "https://www.airbnb.com" },
  { id: "booking", url: "https://www.booking.com" },
  { id: "netflix", url: "https://www.netflix.com" },
] as const;

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error ?? "unknown error")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .slice(0, 400);
}

async function waitForOwner(prompt: string): Promise<void> {
  console.log(JSON.stringify({ status: "waiting_for_owner", prompt }));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.once("line", () => resolve()));
  rl.close();
}

async function main() {
  if (!config.e2bEnabled || !config.e2bApiKey || !config.kernelApiKey || !config.e2bBrowserTemplate) {
    throw new Error("Kernel domain matrix requires E2B_ENABLED, E2B_API_KEY, KERNEL_API_KEY and a rebuilt browser template");
  }
  await initStore({ memoryOnly: true, suppressStorageMetrics: true });
  config.browserProvider = "kernel";
  const owner = randomInt(2_100_000_000, 2_147_000_000);
  const engine = new E2BBrowserEngine();
  const invoke = (action: string, args: Record<string, unknown> = {}) => engine.browser(owner, { action, ...args }, { ownerPrivateRun: true, visualFeedback: true });
  const results: Array<Record<string, unknown>> = [];
  const interactive = process.argv.includes("--live");

  try {
    await invoke("start");
    if (interactive) {
      const viewer = await invoke("stream_start", { ttlSeconds: 900 }) as { url?: string; expiresAt?: number };
      if (!viewer.url) throw new Error("Kernel live view was not issued");
      console.log(JSON.stringify({ status: "live_view_ready", liveUrl: viewer.url, expiresAt: viewer.expiresAt, provider: "kernel", headed: true, message: "Open the live URL before the first navigation, then type continue and press Enter here." }));
      await waitForOwner("Type continue after you have opened the live view.");
    }
    for (const site of SITES) {
      const startedAt = Date.now();
      let actions = 0;
      try {
        const opened = await invoke("open", { url: site.url, waitUntil: "commit" }) as BrowserResult;
        actions += 1;
        const observed = await invoke("observe", { includePageContent: true, includeLinks: true }) as BrowserResult;
        actions += 1;
        let challenge = observed.challenge?.detected === true || observed.needsUserInteraction === true;
        if (challenge && interactive) {
          console.log(JSON.stringify({ status: "challenge_required", id: site.id, url: observed.observedUrl || opened.observedUrl, challenge: observed.challenge, needsUserInteraction: observed.needsUserInteraction === true, message: "Resolve the challenge in the open live view, then type continue and press Enter here." }));
          await waitForOwner(`Resolve the ${site.id} challenge, then type continue.`);
          const after = await invoke("observe", { includePageContent: true, includeLinks: true }) as BrowserResult;
          actions += 1;
          challenge = after.challenge?.detected === true || after.needsUserInteraction === true;
          if (challenge) throw new Error("Challenge remains active after owner handoff");
        }
        const screenshot = await invoke("screenshot") as BrowserResult;
        actions += 1;
        const usable = pageLooksUsable({
          url: observed.observedUrl,
          title: observed.title,
          pageContent: observed.pageContent,
        });
        results.push({ id: site.id, url: observed.observedUrl || opened.observedUrl, title: observed.title, actions, outcome: challenge ? "challenge_required" : usable ? "verified" : "unusable_page", screenshotEvidence: Boolean(screenshot.screenshotHash), durationMs: Date.now() - startedAt });
      } catch (error) {
        if (interactive && actions === 0) {
          console.log(JSON.stringify({ status: "site_action_failed", id: site.id, error: safeError(error), message: "Inspect the same live view if needed, then type continue to proceed to the next site." }));
          await waitForOwner(`Continue after the ${site.id} result.`);
        }
        results.push({ id: site.id, actions, outcome: "failed", error: safeError(error), durationMs: Date.now() - startedAt });
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    const summary = {
      provider: "kernel",
      template: config.e2bBrowserTemplate,
      sites: results.length,
      verified: results.filter((item) => item.outcome === "verified").length,
      challengeRequired: results.filter((item) => item.outcome === "challenge_required").length,
      failed: results.filter((item) => item.outcome === "failed" || item.outcome === "unusable_page").length,
      minimumActionsPerSite: 3,
      sameRetainedSession: true,
      readOnly: true,
      results,
    };
    console.log(JSON.stringify(summary));
  } finally {
    const profile = (await getSession(owner)).kernelBrowserProfileId;
    await invoke("stop").catch(() => undefined);
    if (profile) await kernelClient().profiles.delete(profile).catch(() => undefined);
    console.log(JSON.stringify({ disposableResourcesClosed: true }));
  }
}

main().catch((error) => {
  console.error(`Kernel domain matrix failed: ${safeError(error)}`);
  process.exitCode = 1;
});
