import "dotenv/config";
import { Sandbox } from "e2b";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
if (!apiKey) throw new Error("E2B_API_KEY is required");

async function main() {
  const sandbox = await Sandbox.create(template, { apiKey, timeoutMs: 300_000, requestTimeoutMs: 120_000, allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false", metadata: { app: "chusky", purpose: "browser-smoke" } });
  try {
    const run = async (label: string, command: string, options: Record<string, unknown> = {}) => {
      try {
        return await sandbox.commands.run(command, options as never);
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    await run("runtime directory", "mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
    await run("Xvfb", "Xvfb :99 -screen 0 1440x900x24 >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("Fluxbox", "fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("browser daemon", "node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const requestBrowser = async (request: Record<string, unknown>) => {
      let result;
      try {
        result = await run("browser client", "node /app/browser-client.mjs", {
          cwd: "/app",
          envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url") },
          timeoutMs: 60_000,
          requestTimeoutMs: 120_000,
        });
      } catch (error) {
        const diagnostics = await sandbox.commands.run("printf '%s\\n' '--- processes ---'; ps -ef | grep -E 'Xvfb|fluxbox|browser-agent' | grep -v grep || true; printf '%s\\n' '--- browser ---'; tail -100 /tmp/chusky-browser-agent.log 2>/dev/null || true").catch(() => ({ stdout: "", stderr: "" }));
        throw new Error([error instanceof Error ? error.message : String(error), diagnostics.stdout].filter(Boolean).join("\n").slice(0, 8_000));
      }
      if (result.exitCode !== 0) {
        const diagnostics = await sandbox.commands.run("tail -100 /tmp/chusky-browser-agent.log 2>/dev/null || true").catch(() => ({ stdout: "", stderr: "" }));
        throw new Error([result.stderr, result.stdout, diagnostics.stdout].filter(Boolean).join("\n").slice(0, 4_000));
      }
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
      if (!parsed.ok) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 500)}`);
      return parsed as Record<string, unknown>;
    };
    const opened = await requestBrowser({ action: "open", url: process.argv[2] || "https://www.iana.org/help/example-domains" });
    const found = await requestBrowser({ action: "find", role: "link", limit: 5 });
    const firstLink = Array.isArray(found.matches) ? found.matches[0] as { role?: string; name?: string; index?: number } | undefined : undefined;
    if (!firstLink?.name) throw new Error(`No accessible link found on ${String(opened.url || process.argv[2])}`);
    const clicked = await requestBrowser({ action: "click", selector: { role: firstLink.role || "link", name: firstLink.name, nameMatch: "substring", index: firstLink.index ?? 0 } });
    const screenshot = await requestBrowser({ action: "screenshot" });
    const screenshotBytes = typeof screenshot.screenshot === "string" ? Buffer.from(screenshot.screenshot, "base64").length : 0;
    const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || "artifacts/e2b-browser-smoke");
    await mkdir(artifactDir, { recursive: true });
    const screenshotPath = path.join(artifactDir, "browser.png");
    const reportPath = path.join(artifactDir, "report.json");
    if (typeof screenshot.screenshot === "string") await writeFile(screenshotPath, Buffer.from(screenshot.screenshot, "base64"));
    const report = { ok: true, sandboxId: sandbox.sandboxId, opened: { url: opened.url, title: opened.title }, links: Array.isArray(found.matches) ? found.matches : [], clicked: { url: clicked.url, title: clicked.title }, screenshotBytes, screenshotPath };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportPath }));
  } finally {
    await sandbox.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
