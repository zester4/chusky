import "dotenv/config";
import { Sandbox } from "e2b";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "../src/lib/e2b/networkPolicy.js";
import { phaseTimeoutMs } from "../src/lib/e2b/liveSmoke.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const apiKey = process.env.E2B_API_KEY?.trim();
const template = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
const artifactDir = path.resolve(process.env.E2B_SMOKE_ARTIFACT_DIR || path.join(tmpdir(), "chusky-e2b-agent-browser-smoke"));
const harness = process.env.E2B_BROWSER_HARNESS?.trim().toLowerCase() || "agent-browser";
const engine = process.env.E2B_BROWSER_ENGINE?.trim().toLowerCase() || "chrome";
if (!apiKey) throw new Error("E2B_API_KEY is required");
if (harness !== "playwright" && harness !== "agent-browser") throw new Error("E2B_BROWSER_HARNESS must be playwright or agent-browser");
if (engine !== "chrome" && engine !== "chromium") throw new Error("E2B_BROWSER_ENGINE must be chrome or chromium");

type BrowserResult = Record<string, any> & {
  matches?: Array<Record<string, any>>;
  agentBrowser?: { provider?: string; available?: boolean; refCount?: number; snapshot?: string; error?: string };
  screenshot?: string;
  screenshotHash?: string;
  pageContent?: string;
  url?: string;
  title?: string;
  health?: { runtime?: { engine?: string; headless?: boolean; executable?: string } };
  wait?: { conditioned?: boolean };
};

async function main() {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: 300_000,
      requestTimeoutMs: phaseTimeoutMs("startup"),
      allowInternetAccess: process.env.E2B_ALLOW_INTERNET !== "false",
      network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
      envs: { CHUSKY_BROWSER_HARNESS: harness, CHUSKY_BROWSER_ENGINE: engine, CHUSKY_BROWSER_CDP_PORT: "9222" },
      metadata: { app: "chusky", purpose: "disposable-agent-browser-real-site-smoke" },
    });
    const run = async (label: string, command: string, options: Record<string, unknown> = {}) => {
      try { return await sandbox!.commands.run(command, options as never); }
      catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    await run("runtime directory", "mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
    await run("Xvfb", "Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("Fluxbox", "fluxbox >/tmp/chusky-fluxbox.log 2>&1", { background: true, envs: displayEnv, requestTimeoutMs: 120_000 });
    await run("browser daemon", "node /app/browser-agent.mjs --server >/tmp/chusky-browser-agent.log 2>&1", { background: true, envs: { ...displayEnv, CHUSKY_E2B_SMOKE_TESTS: "1" }, requestTimeoutMs: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const requestBrowser = async (request: Record<string, unknown>, phase: "navigation" | "action" = "action") => {
      const responseFile = `/tmp/chusky-agent-browser-response-${randomUUID()}.json`;
      const response = await run("browser client", "node /app/browser-client.mjs", {
        cwd: "/app",
        envs: { ...displayEnv, CHUSKY_E2B_REQUEST_B64: Buffer.from(JSON.stringify(request), "utf8").toString("base64url"), CHUSKY_E2B_RESPONSE_FILE: responseFile },
        timeoutMs: phaseTimeoutMs(phase),
        requestTimeoutMs: phaseTimeoutMs(phase),
      });
      const wrapper = JSON.parse(response.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}") as Record<string, any>;
      const responseText = typeof wrapper.responseFile === "string" ? Buffer.from(await sandbox!.files.read(wrapper.responseFile, { format: "bytes" })).toString("utf8") : response.stdout;
      if (typeof wrapper.responseFile === "string") await sandbox!.commands.run(`rm -f ${wrapper.responseFile}`, { timeoutMs: 5_000 }).catch(() => undefined);
      const parsed = JSON.parse(responseText.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}") as BrowserResult;
      if (parsed.ok !== true) throw new Error(`Unexpected browser result: ${JSON.stringify(parsed).slice(0, 800)}`);
      return parsed;
    };
    const check = (name: string, ok: boolean, detail?: string) => {
      checks.push({ name, ok, ...(detail ? { detail } : {}) });
      if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
    };
    const selectorFor = (item: Record<string, any>) => ({
      role: item.role,
      name: item.name,
      index: item.index,
      ...(item.id ? { id: item.id } : {}),
      ...(item.placeholder ? { placeholder: item.placeholder } : {}),
      ...(item.observationId ? { observationId: item.observationId } : {}),
      ...(item.pageGeneration !== undefined ? { pageGeneration: item.pageGeneration } : {}),
    });
    const capture = async (name: string, result: BrowserResult) => {
      if (typeof result.screenshot !== "string") throw new Error(`No screenshot returned for ${name}`);
      const file = path.join(artifactDir, `${name}.jpg`);
      await writeFile(file, Buffer.from(result.screenshot, "base64"));
      return file;
    };
    await mkdir(artifactDir, { recursive: true });

    const health = await requestBrowser({ action: "health" });
    const expectedEngine = engine === "chrome" ? "chrome-for-testing" : "playwright-chromium";
    check("real headed browser runtime is active", health.health?.runtime?.engine === expectedEngine && health.health?.runtime?.headless === false, JSON.stringify(health.health?.runtime));

    const iana = await requestBrowser({ action: "open", url: "https://www.iana.org/help/example-domains" }, "navigation");
    const ianaView = await requestBrowser({ action: "observe", includeForms: false, includeScreenshot: true });
    check("real IANA page opens", iana.url?.includes("iana.org/help/example-domains") === true, JSON.stringify({ url: iana.url, title: iana.title }));
    if (harness === "agent-browser") check("agent-browser observes the same IANA page", ianaView.agentBrowser?.available === true && Number(ianaView.agentBrowser.refCount) > 5, JSON.stringify(ianaView.agentBrowser));
    const ianaShot = await capture("iana", ianaView);

    const reserved = ianaView.matches?.find((item) => item.role === "link" && String(item.name).includes("IANA-managed Reserved Domains"));
    if (!reserved) throw new Error("IANA accessible snapshot did not expose the reserved-domains link");
    const clicked = await requestBrowser({ action: "click", selector: selectorFor(reserved) });
    const reservedView = await requestBrowser({ action: "wait", urlIncludes: "/domains/reserved", timeoutSeconds: 10 });
    check("real semantic click reaches the reserved-domains page", clicked.url?.includes("/domains/reserved") === true && reservedView.wait?.conditioned === true, JSON.stringify({ url: clicked.url, wait: reservedView.wait }));

    const todo = await requestBrowser({ action: "open", url: "https://demo.playwright.dev/todomvc/" }, "navigation");
    const todoView = await requestBrowser({ action: "observe", includeForms: false, includeScreenshot: true });
    const todoInput = todoView.matches?.find((item) => item.role === "textbox") || { role: "textbox", placeholder: "What needs to be done?", index: 0 };
    await requestBrowser({ action: "fill", selector: selectorFor(todoInput), value: "Chusky agent-browser proof" });
    await requestBrowser({ action: "press", selector: selectorFor(todoInput), key: "Enter" });
    const todoResult = await requestBrowser({ action: "wait", textIncludes: "Chusky agent-browser proof", timeoutSeconds: 10 });
    const todoAfter = await requestBrowser({ action: "observe", includeForms: false, includePageContent: true, includeScreenshot: true });
    check("real TodoMVC interaction is independently visible", todo.url?.includes("demo.playwright.dev/todomvc") === true && todoResult.wait?.conditioned === true && String(todoAfter.pageContent).includes("Chusky agent-browser proof"), JSON.stringify({ url: todoAfter.url, title: todoAfter.title, wait: todoResult.wait }));
    if (harness === "agent-browser") check("agent-browser remains attached after interaction", todoAfter.agentBrowser?.available === true && Number(todoAfter.agentBrowser.refCount) > 0, JSON.stringify(todoAfter.agentBrowser));
    const todoShot = await capture("todomvc", todoAfter);

    await mkdir(artifactDir, { recursive: true });
    const report = { ok: checks.every((item) => item.ok), sandboxId: sandbox.sandboxId, template, harness, engine, runtime: health.health?.runtime, screenshots: { iana: ianaShot, todomvc: todoShot }, checks };
    await writeFile(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, reportPath: path.join(artifactDir, "report.json") }));
  } catch (error) {
    checks.push({ name: "smoke execution", ok: false, detail: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000) });
    await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
    await writeFile(path.join(artifactDir, "report.json"), JSON.stringify({ ok: false, template, harness, engine, checks }, null, 2)).catch(() => undefined);
    console.log(JSON.stringify({ ok: false, template, harness, engine, sandboxId: sandbox?.sandboxId, checks }));
    process.exitCode = 1;
  } finally {
    if (sandbox) await sandbox.kill().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
