import "dotenv/config";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";
import { browserChallengeStillActive } from "../src/lib/e2b/handoffStatus.js";

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
const targetUrl = process.argv.find((value) => /^https:\/\//i.test(value)) || "https://www.target.com/";
const requestedDuration = Number(process.env.E2B_HANDOFF_DURATION_MS || 15 * 60_000);
const durationMs = Number.isInteger(requestedDuration) && requestedDuration >= 120_000 ? Math.min(requestedDuration, 30 * 60_000) : 15 * 60_000;

if (!apiKey) throw new Error("E2B_API_KEY is required");

function detail(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return String(raw || "").replace(/password=[^&\s]+/gi, "password=[redacted]").slice(0, 1_200);
}

async function main() {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: durationMs,
      requestTimeoutMs: phaseTimeoutMs("startup"),
      allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
      network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
      metadata: { app: "chusky", purpose: "owner-browser-handoff-verification" },
    });
    const run = async (command: string, options: Record<string, unknown> = {}) => sandbox!.commands.run(command, options as never);
    const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    await run("mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
    await run("Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb-handoff.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
    await run("fluxbox >/tmp/chusky-fluxbox-handoff.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("startup") });
    const browserEnv = {
      ...displayEnv,
      CHUSKY_E2B_SMOKE_TESTS: "1",
      ...(process.env.CHUSKY_BROWSER_LOCALE ? { CHUSKY_BROWSER_LOCALE: process.env.CHUSKY_BROWSER_LOCALE } : {}),
      ...(process.env.CHUSKY_BROWSER_TIMEZONE ? { CHUSKY_BROWSER_TIMEZONE: process.env.CHUSKY_BROWSER_TIMEZONE } : {}),
      ...(process.env.CHUSKY_BROWSER_GEOLOCATION ? { CHUSKY_BROWSER_GEOLOCATION: process.env.CHUSKY_BROWSER_GEOLOCATION } : {}),
      ...(process.env.CHUSKY_BROWSER_DISABLE_GPU ? { CHUSKY_BROWSER_DISABLE_GPU: process.env.CHUSKY_BROWSER_DISABLE_GPU } : {}),
    };
    await run("node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent-handoff.log 2>&1", { background: true, envs: browserEnv, requestTimeoutMs: phaseTimeoutMs("startup") });

    const readyBy = Date.now() + phaseTimeoutMs("startup");
    while (Date.now() < readyBy) {
      const healthCommand = `node -e "fetch('http://127.0.0.1:8765/health').then(async r=>{console.log(r.ok?'ready':'not-ready');await r.arrayBuffer()}).catch(()=>console.log('not-ready'))"`;
      const probe = await run(healthCommand, { envs: displayEnv, timeoutMs: 5_000 }).catch(() => ({ exitCode: 1, stdout: "" }));
      if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).at(-1) === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const response = async (request: Record<string, unknown>, phase: "navigation" | "action" | "handoff" = "action") => {
      const responseFile = `/tmp/chusky-handoff-${randomUUID()}.json`;
      const result = await run("node /app/browser-client.mjs", {
        cwd: "/app",
        envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
        timeoutMs: phaseTimeoutMs(phase),
        requestTimeoutMs: phaseTimeoutMs(phase),
      });
      if (result.exitCode !== 0) throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 2_000));
      const wrapper = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
      const body = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox!.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : result.stdout;
      await run(`rm -f ${responseFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
      const parsed = JSON.parse(body.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
      if (parsed.ok !== true) throw new Error(`Browser request failed: ${detail(parsed)}`);
      return parsed as Record<string, any>;
    };

    await response({ action: "open", url: targetUrl }, "navigation");
    const initial = await response({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "navigation");
    const password = randomUUID().replaceAll("-", "").slice(0, 12);
    const passwordFile = "/tmp/chusky-handoff-vnc-password";
    await sandbox.files.write(passwordFile, Uint8Array.from(Buffer.from(password, "utf8")).buffer);
    await run(`chmod 600 ${passwordFile}`);
    await run(`x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwdfile ${passwordFile} >/tmp/chusky-x11vnc-handoff.log 2>&1`, { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("handoff") });
    await run("websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/chusky-websockify-handoff.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: phaseTimeoutMs("handoff") });
    const host = sandbox.getHost(6080);
    const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    const liveUrl = `${base}/chusky-vnc.html#autoconnect=1&resize=scale&password=${encodeURIComponent(password)}`;
    const challenge = initial.challenge && typeof initial.challenge === "object" ? initial.challenge : { detected: false };
    console.log(JSON.stringify({ status: "ready", sandboxId: sandbox.sandboxId, liveUrl, targetUrl, observedUrl: initial.url, title: initial.title, challenge, browserProfile: { headed: true, persistent: true, locale: process.env.CHUSKY_BROWSER_LOCALE || "en-US", timezone: process.env.CHUSKY_BROWSER_TIMEZONE || "America/New_York", geolocationConfigured: Boolean(process.env.CHUSKY_BROWSER_GEOLOCATION), gpuDisabled: process.env.CHUSKY_BROWSER_DISABLE_GPU === "true" }, expiresAt: Date.now() + durationMs }));
    console.log("Complete the browser step, then type done and press Enter.");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const command = await new Promise<string>((resolve) => rl.once("line", resolve));
    rl.close();
    if (!/^(done|continue)$/i.test(command.trim())) {
      console.log(JSON.stringify({ status: "stopped", reason: "owner_did_not_confirm_completion", sandboxId: sandbox.sandboxId }));
      return;
    }
    let after = await response({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "handoff");
    // A challenge can navigate asynchronously after the owner releases the
    // control. Give the site a short, bounded settling window, but never turn
    // the owner's message into proof that the challenge passed.
    const settleBy = Date.now() + 8_000;
    while (browserChallengeStillActive(after) && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      after = await response({ action: "observe", includeScreenshot: true, includePageContent: true, includeLinks: true }, "handoff");
    }
    const diagnostics = await response({ action: "diagnostics" }, "handoff").catch((error) => ({ error: detail(error) }));
    const challengeStillActive = browserChallengeStillActive(after);
    console.log(JSON.stringify({
      status: challengeStillActive ? "challenge_still_active" : "owner_returned",
      resolutionState: challengeStillActive ? "handoff_required" : "ready_to_verify",
      sandboxId: sandbox.sandboxId,
      observedUrl: after.url,
      title: after.title,
      challenge: after.challenge,
      needsUserInteraction: after.needsUserInteraction === true,
      screenshotCaptured: typeof after.screenshot === "string",
      diagnostics: { available: !((diagnostics as any).error) },
    }));
  } catch (error) {
    console.error(detail(error));
    process.exitCode = 1;
  } finally {
    await sandbox?.kill().catch(() => undefined);
  }
}

main();
