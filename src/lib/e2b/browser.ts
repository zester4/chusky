import { Sandbox } from "e2b";
import { randomUUID, createHash } from "node:crypto";
import { config } from "../../config.js";
import { getSession, saveSession } from "../../store.js";
import { guardVaultBrowserAction, rememberVaultBrowserNodes } from "../../vault/browserGuard.js";
import { redactBrowserText } from "../../vault/browserObservation.js";
import { assertE2BBrowserHandoffAllowsAction, normalizeE2BBrowserFileName, normalizeE2BPageContent } from "./contracts.js";
import { E2BBrowserError } from "./errors.js";
import { assertSafeBrowserUrl } from "./urlSafety.js";
import { E2B_BROWSER_DENY_OUT_CIDRS } from "./networkPolicy.js";
import { deleteR2Object, putR2Object, r2Configured, readR2Object } from "../../lib/storage/r2.js";
import { E2B_BROWSER_ACTIONS, type E2BBrowserAction, type E2BBrowserFileRecord, type E2BBrowserNode, type E2BBrowserRecord, type E2BCommandResult } from "./types.js";
import { planFormSubmission, type RequestedFormField } from "./formPlanner.js";
import { auxiliaryBrowserRequest } from "./auxiliaryActions.js";
import { webBotAuthConfigurationIssue, webBotAuthConfigurationStatus, webBotAuthKeyId, webBotAuthSandboxEnvironment, webBotAuthSigningEnabled } from "../../webBotAuth.js";

const MAX_OUTPUT = 16_000;
const MAX_NODES = 60;
const NODE_TTL_MS = 2 * 60_000;
const MAX_BROWSER_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BROWSER_RECORDING_BYTES = 100 * 1024 * 1024;
const BROWSER_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const locks = new Map<number, Promise<void>>();

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new E2BBrowserError(`${field} must be 1-${max} characters`);
  return value.trim();
}

function safeAction(value: unknown): E2BBrowserAction {
  const action = boundedText(value, "action", 32) as E2BBrowserAction;
  if (!(E2B_BROWSER_ACTIONS as readonly string[]).includes(action)) throw new E2BBrowserError(`Unsupported E2B browser action: ${action}`);
  return action;
}

function browserContentType(name: string, kind: "download" | "recording"): string {
  if (kind === "recording") return "video/mp4";
  const extension = name.toLowerCase().split(".").at(-1);
  const types: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown", html: "text/html", htm: "text/html", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav" };
  return types[extension ?? ""] ?? "application/octet-stream";
}

function nodeId(role: string, name: string, index: number, observationId?: string, frameIndex?: number): string {
  return `e2b_${createHash("sha256").update(`${role}\0${name}\0${index}\0${observationId ?? "legacy"}\0${frameIndex ?? 0}`).digest("hex").slice(0, 28)}`;
}

function encodeRequest(request: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function parseResult(stdout: string, stderr: string): E2BCommandResult {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new E2BBrowserError(`E2B browser returned no result${stderr ? `: ${redactBrowserText(stderr, 500)}` : ""}`);
  try { return JSON.parse(line) as E2BCommandResult; }
  catch { throw new E2BBrowserError(`E2B browser returned invalid result${stderr ? `: ${redactBrowserText(stderr, 500)}` : ""}`); }
}

function browserFailureCode(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("observation_stale") || value.includes("fresh accessible node")) return "stale_observation";
  if (value.includes("ambiguous")) return "control_ambiguous";
  if (value.includes("not found") || value.includes("was not found")) return "control_missing";
  if (value.includes("frame")) return "frame_missing";
  if (value.includes("challenge") || value.includes("captcha") || value.includes("two_factor")) return "challenge_detected";
  if (value.includes("timeout") || value.includes("timed out")) return "action_timeout";
  return "browser_action_failed";
}

function normalizeMatches(raw: E2BCommandResult, url: string, now: number): E2BBrowserNode[] {
  return (Array.isArray(raw.matches) ? raw.matches : []).slice(0, MAX_NODES).flatMap((item) => {
    const role = redactBrowserText(item?.role, 40).toLowerCase();
    const name = redactBrowserText(item?.name, 160);
    const index = Number(item?.index);
    if (!role || !name || !Number.isSafeInteger(index) || index < 0) return [];
    const optional = (field: "id" | "nameAttr" | "placeholder" | "autocomplete" | "inputType" | "tagName" | "frameUrl" | "observationId", max: number) => {
      const value = item?.[field];
      return typeof value === "string" && value.trim() && value.length <= max ? { [field]: redactBrowserText(value, max) } : {};
    };
    const frameIndex = Number(item?.frameIndex);
    const pageGeneration = Number(item?.pageGeneration);
    return [{ nodeId: nodeId(role, name, index, typeof item?.observationId === "string" ? item.observationId : undefined, Number.isSafeInteger(frameIndex) ? frameIndex : undefined), role, name, index, ...optional("id", 160), ...optional("nameAttr", 160), ...optional("placeholder", 200), ...optional("autocomplete", 80), ...optional("inputType", 40), ...optional("tagName", 40), ...(Number.isSafeInteger(frameIndex) && frameIndex >= 0 ? { frameIndex } : {}), ...optional("frameUrl", 1_000), ...optional("observationId", 100), ...(Number.isSafeInteger(pageGeneration) && pageGeneration >= 0 ? { pageGeneration } : {}), url, capturedAt: now }];
  });
}

const INTERACTIVE_ACTIONS = ["invoke", "fill", "focus", "click", "move", "hover", "select_option", "check", "uncheck", "type", "press", "upload", "upload_files"] as const;
const SAFE_REPLAN_ACTIONS = ["fill", "select_option", "check", "uncheck", "focus", "hover", "wait"] as const;

function requestedFormFields(value: unknown): RequestedFormField[] {
  if (!Array.isArray(value) || value.length > 100) throw new E2BBrowserError("fields must be an array of at most 100 form fields");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new E2BBrowserError(`fields[${index}] must be an object`);
    const field = item as Record<string, unknown>;
    const label = boundedText(field.label, `fields[${index}].label`, 200);
    if (field.value !== undefined && (typeof field.value !== "string" || field.value.length > 8_000)) throw new E2BBrowserError(`fields[${index}].value is invalid`);
    if (field.checked !== undefined && typeof field.checked !== "boolean") throw new E2BBrowserError(`fields[${index}].checked must be boolean`);
    const action = field.action === undefined ? undefined : boundedText(field.action, `fields[${index}].action`, 32) as RequestedFormField["action"];
    if (action && !["fill", "select_option", "check", "uncheck"].includes(action)) throw new E2BBrowserError(`fields[${index}].action is unsupported`);
    return { label, ...(field.value !== undefined ? { value: field.value as string } : {}), ...(field.checked !== undefined ? { checked: field.checked as boolean } : {}), ...(action ? { action } : {}) };
  });
}

function selectorForNode(node: E2BBrowserNode): Record<string, unknown> {
  return {
    role: node.role,
    name: node.name,
    index: node.index,
    id: node.id,
    nameAttr: node.nameAttr,
    placeholder: node.placeholder,
    autocomplete: node.autocomplete,
    inputType: node.inputType,
    tagName: node.tagName,
    frameIndex: node.frameIndex,
    frameUrl: node.frameUrl,
    observationId: node.observationId,
    pageGeneration: node.pageGeneration,
  };
}

async function withUserLock<T>(userId: number, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(userId, current);
  await previous;
  try { return await operation(); } finally { release(); if (locks.get(userId) === current) locks.delete(userId); }
}

export class E2BBrowserEngine {
  private async record(userId: number): Promise<E2BBrowserRecord | undefined> {
    return (await getSession(userId)).e2bBrowser;
  }

  private async save(userId: number, browser: E2BBrowserRecord | undefined): Promise<void> {
    const session = await getSession(userId);
    session.e2bBrowser = browser;
    await saveSession(userId, session);
  }

  private async sandbox(userId: number, create = true): Promise<{ sandbox: Sandbox; record: E2BBrowserRecord }> {
    if (!config.e2bEnabled || !config.e2bApiKey) throw new E2BBrowserError("E2B browser is disabled. Configure E2B_ENABLED=true and E2B_API_KEY.");
    if (config.webBotAuthSignRequests && !webBotAuthSigningEnabled()) throw new E2BBrowserError(webBotAuthConfigurationIssue() ?? "Web Bot Auth signing is enabled but its configuration is invalid.");
    const prior = await this.record(userId);
    const now = Date.now();
    if (prior?.sandboxId && prior.expiresAt > now) {
      const authConfigured = webBotAuthSigningEnabled();
      const expectedKeyId = authConfigured ? webBotAuthKeyId() : undefined;
      if (authConfigured && prior.webBotAuthKeyId !== expectedKeyId) throw new E2BBrowserError("Web Bot Auth identity changed for this retained browser. Stop and start the browser to safely load the new identity.");
      try {
        let sandbox: Sandbox | undefined;
        let connectError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            sandbox = await Sandbox.connect(prior.sandboxId, { apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
            break;
          } catch (error) {
            connectError = error;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
        if (!sandbox) throw connectError instanceof Error ? connectError : new Error("E2B sandbox connection failed");
        await sandbox.setTimeout(config.e2bTimeoutMs, { requestTimeoutMs: config.e2bRequestTimeoutMs });
        await this.ensureRuntime(sandbox);
        return { sandbox, record: prior };
      } catch (error) {
        if (!create) throw error;
        await this.runtimeDiagnostics(prior.sandboxId);
        await this.retireSandbox(prior.sandboxId);
        await this.save(userId, undefined);
      }
    }
    if (!create) throw new E2BBrowserError("No active E2B browser sandbox exists. Start the browser first.");
    const expiresAt = now + config.e2bTimeoutMs;
    const sandbox = await Sandbox.create(config.e2bBrowserTemplate, {
      apiKey: config.e2bApiKey,
      timeoutMs: config.e2bTimeoutMs,
      requestTimeoutMs: config.e2bRequestTimeoutMs,
      allowInternetAccess: config.e2bAllowInternetAccess,
      network: { allowPublicTraffic: true, denyOut: [...E2B_BROWSER_DENY_OUT_CIDRS] },
      lifecycle: { onTimeout: config.e2bAutoPause ? "pause" : "kill", autoResume: config.e2bAutoPause },
      envs: { ...webBotAuthSandboxEnvironment(), CHUSKY_BROWSER_LOCALE: config.e2bBrowserLocale, CHUSKY_BROWSER_TIMEZONE: config.e2bBrowserTimezone, CHUSKY_BROWSER_GEOLOCATION: config.e2bBrowserGeolocation },
      metadata: { app: "chusky", surface: "browser", owner: String(userId) },
    });
    const next: E2BBrowserRecord = { sandboxId: sandbox.sandboxId, webBotAuthKeyId: webBotAuthSigningEnabled() ? webBotAuthKeyId() : undefined, createdAt: now, updatedAt: now, expiresAt };
    await this.ensureRuntime(sandbox);
    await this.save(userId, next);
    return { sandbox, record: next };
  }

  private async retireSandbox(sandboxId: string): Promise<void> {
    try {
      await Sandbox.kill(sandboxId, { apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
    } catch {
      // Cleanup is best effort; the new sandbox must not inherit a stale record.
    }
  }

  private async runtimeDiagnostics(sandboxId: string): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(sandboxId, { apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
      const result = await sandbox.commands.run("printf '%s\\n' '[processes]'; ps -eo pid,comm,args | grep -E 'Xvfb|fluxbox|browser-agent|chromium' | grep -v grep | head -20; for file in /tmp/chusky-xvfb.log /tmp/chusky-fluxbox.log /tmp/chusky-browser.log; do if [ -f \"$file\" ]; then printf '%s\\n' \"[$file]\"; tail -20 \"$file\"; fi; done", { timeoutMs: 5_000, requestTimeoutMs: config.e2bRequestTimeoutMs });
      return redactBrowserText((result.stdout || result.stderr || "").replace(/(?:token|secret|password|cookie|authorization)[^\\n]*/gi, "[redacted]"), 2_000);
    } catch {
      return "diagnostics unavailable";
    }
  }

  private async ensureRuntime(sandbox: Sandbox): Promise<void> {
    const displayEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    const startIfMissing = async (command: string) => {
      await sandbox.commands.run(command, {
        envs: displayEnv,
        requestTimeoutMs: config.e2bRequestTimeoutMs,
      });
    };
    // Keep each long-lived process in its own command. E2B can report a
    // nested background shell as exit status 2 even when one child started;
    // splitting the launches makes startup observable and idempotent.
    await startIfMissing("mkdir -p /tmp/chusky-runtime && chmod 700 /tmp/chusky-runtime");
    await startIfMissing("if [ ! -f /tmp/chusky-xvfb.pid ] || ! kill -0 $(cat /tmp/chusky-xvfb.pid) 2>/dev/null; then nohup Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1 & echo $! >/tmp/chusky-xvfb.pid; fi");
    await startIfMissing("if [ ! -f /tmp/chusky-fluxbox.pid ] || ! kill -0 $(cat /tmp/chusky-fluxbox.pid) 2>/dev/null; then nohup fluxbox >/tmp/chusky-fluxbox.log 2>&1 & echo $! >/tmp/chusky-fluxbox.pid; fi");
    await startIfMissing("if [ ! -f /tmp/chusky-browser.pid ] || ! kill -0 $(cat /tmp/chusky-browser.pid) 2>/dev/null; then nohup node /app/browser-agent.mjs --server >/tmp/chusky-browser.log 2>&1 & echo $! >/tmp/chusky-browser.pid; fi");
    let lastError = "browser daemon did not become ready";
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const probe = await sandbox.commands.run("node -e \"fetch('http://127.0.0.1:8765/health').then(async r => { console.log(JSON.stringify({status:r.status,body:await r.text()})); }).catch(error => console.log(JSON.stringify({error:String(error)})))\"", { timeoutMs: 5_000, requestTimeoutMs: config.e2bRequestTimeoutMs });
      const probeText = probe.stdout.trim().split(/\r?\n/).at(-1) || "";
      try {
        const payload = JSON.parse(probeText) as { status?: number; body?: string; error?: string };
        if (payload.status === 200 && payload.body && JSON.parse(payload.body).ok === true) return;
        lastError = redactBrowserText(payload.body || payload.error || lastError, 500);
      } catch {
        lastError = redactBrowserText((probe.stderr || probe.stdout || lastError).trim(), 500);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 250 * 2 ** Math.min(attempt, 3))));
    }
    throw new E2BBrowserError(`E2B browser daemon did not become ready: ${lastError}; ${await this.runtimeDiagnostics(sandbox.sandboxId)}`);
  }

  private async run(sandbox: Sandbox, request: Record<string, unknown>): Promise<E2BCommandResult> {
    const browserRequest = { ...request, webBotAuthEnabled: webBotAuthSigningEnabled() };
    const responseFile = `/tmp/chusky-browser-response-${randomUUID()}.json`;
    const result = await sandbox.commands.run("node /app/browser-client.mjs", {
      cwd: "/app",
      envs: { CHUSKY_E2B_REQUEST_B64: encodeRequest(browserRequest), CHUSKY_E2B_RESPONSE_FILE: responseFile },
      timeoutMs: Math.min(config.e2bRequestTimeoutMs, 60_000),
      requestTimeoutMs: config.e2bRequestTimeoutMs,
    });
    if (result.exitCode !== 0) {
      const message = redactBrowserText(result.stderr || result.stdout, 800);
      const code = browserFailureCode(message);
      throw new E2BBrowserError(`E2B browser action failed [${code}]: ${message}${["stale_observation", "control_missing", "control_ambiguous", "frame_missing"].includes(code) ? ". Reinspect the current page before retrying; do not replay the same selector." : ""}`, code);
    }
    let parsed = parseResult(result.stdout, result.stderr) as E2BCommandResult & { responseFile?: string };
    if (typeof parsed.responseFile === "string" && /^\/tmp\/chusky-browser-response-[A-Za-z0-9-]+\.json$/.test(parsed.responseFile)) {
      const responseBytes = Buffer.from(await sandbox.files.read(parsed.responseFile, { format: "bytes" }));
      await sandbox.commands.run(`rm -f ${parsed.responseFile}`, { timeoutMs: 5_000, requestTimeoutMs: config.e2bRequestTimeoutMs }).catch(() => undefined);
      parsed = parseResult(responseBytes.toString("utf8"), result.stderr) as E2BCommandResult & { responseFile?: string };
    }
    if (parsed.ok !== true) {
      const message = redactBrowserText(parsed.error || "E2B browser action failed", 800);
      const code = browserFailureCode(message);
      throw new E2BBrowserError(`${code}: ${message}${["stale_observation", "control_missing", "control_ambiguous", "frame_missing"].includes(code) ? ". Reinspect the current page before retrying; do not replay the same selector." : ""}`, code);
    }
    return parsed;
  }

  private async persistRuntimeFile(userId: number, sandbox: Sandbox, record: E2BBrowserRecord, input: {
    id: string; kind: "download" | "recording"; name: string; size: number; createdAt: number; filePath: string;
  }): Promise<E2BBrowserFileRecord> {
    const session = await getSession(userId);
    const existing = (session.browserFiles ?? []).find((file) => file.sandboxId === record.sandboxId && file.kind === input.kind && file.sourceId === input.id && file.expiresAt > Date.now());
    if (existing) return existing;
    if (!r2Configured()) throw new E2BBrowserError("Cloudflare R2 is required to keep browser downloads and recordings private and available after the sandbox closes.");
    const maxBytes = input.kind === "recording" ? MAX_BROWSER_RECORDING_BYTES : MAX_BROWSER_DOWNLOAD_BYTES;
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxBytes) throw new E2BBrowserError(`Browser ${input.kind} exceeds the ${maxBytes} byte file limit`);
    const allowedRoot = input.kind === "recording" ? "/tmp/chusky-browser-recordings/" : "/tmp/chusky-browser-downloads/";
    if (typeof input.filePath !== "string" || !input.filePath.startsWith(allowedRoot) || input.filePath.includes("..")) throw new E2BBrowserError("Browser runtime returned an invalid private file path");
    const bytes = Buffer.from(await sandbox.files.read(input.filePath, { format: "bytes" }));
    if (bytes.length !== input.size || bytes.length < 1 || bytes.length > maxBytes) throw new E2BBrowserError("Browser file size changed or exceeded its transfer limit");
    const name = normalizeE2BBrowserFileName(input.name);
    const file: E2BBrowserFileRecord = {
      id: `bf_${randomUUID()}`,
      key: `browser/${userId}/${randomUUID()}-${name}`,
      name,
      contentType: browserContentType(name, input.kind),
      size: bytes.length,
      kind: input.kind,
      sourceId: input.id,
      sandboxId: record.sandboxId,
      createdAt: Date.now(),
      expiresAt: Date.now() + BROWSER_FILE_TTL_MS,
    };
    await putR2Object(file.key, bytes, file.contentType);
    session.browserFiles ??= [];
    if (session.browserFiles.length >= 100) {
      await deleteR2Object(file.key).catch(() => undefined);
      throw new E2BBrowserError("The private browser file library has reached its 100-file limit. Delete older browser files before saving another.");
    }
    session.browserFiles.push(file);
    await saveSession(userId, session);
    return file;
  }

  private async syncRuntimeFiles(userId: number, sandbox: Sandbox, record: E2BBrowserRecord, kind: "download" | "recording"): Promise<E2BBrowserFileRecord[]> {
    const listed = await this.run(sandbox, { action: kind === "download" ? "downloads" : "recording_list" });
    const entries = kind === "download" ? listed.downloads : listed.recordings;
    const files: E2BBrowserFileRecord[] = [];
    for (const item of (Array.isArray(entries) ? entries : []).slice(0, 20)) {
      if (!item || item.state !== "ready" || typeof item.id !== "string" || typeof item.name !== "string" || !Number.isFinite(item.size)) continue;
      const claim = await this.run(sandbox, { action: kind === "download" ? "download_claim" : "recording_claim", id: item.id });
      if (typeof claim.filePath !== "string" || typeof claim.name !== "string" || !Number.isFinite(claim.size) || !Number.isFinite(claim.createdAt)) continue;
      const file = await this.persistRuntimeFile(userId, sandbox, record, { id: item.id, kind, name: claim.name, size: Number(claim.size), createdAt: Number(claim.createdAt), filePath: claim.filePath });
      files.push(file);
      await this.run(sandbox, { action: kind === "download" ? "download_ack" : "recording_ack", id: item.id });
    }
    return files;
  }

  private async browserFile(userId: number, fileId: unknown, kind?: "download" | "recording"): Promise<E2BBrowserFileRecord> {
    const id = boundedText(fileId, "fileId", 128);
    const file = (await getSession(userId)).browserFiles?.find((item) => (item.id === id || item.sourceId === id) && item.expiresAt > Date.now() && (!kind || item.kind === kind));
    if (!file) throw new E2BBrowserError("Browser file not found, expired, or not owned by this account");
    return file;
  }

  private async storedBrowserFiles(userId: number, kind: "download" | "recording"): Promise<E2BBrowserFileRecord[]> {
    const session = await getSession(userId);
    return (session.browserFiles ?? [])
      .filter((file) => file.kind === kind && file.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }

  private async purgeExpiredBrowserFiles(userId: number): Promise<void> {
    if (!r2Configured()) return;
    const session = await getSession(userId);
    const files = session.browserFiles ?? [];
    const expired = files.filter((file) => file.expiresAt <= Date.now());
    if (!expired.length) return;
    const results = await Promise.allSettled(expired.map((file) => deleteR2Object(file.key)));
    const failedIds = new Set(results.flatMap((result, index) => result.status === "rejected" ? [expired[index]!.id] : []));
    session.browserFiles = files.filter((file) => file.expiresAt > Date.now() || failedIds.has(file.id));
    await saveSession(userId, session);
  }

  private async persistResult(userId: number, record: E2BBrowserRecord, result: E2BCommandResult, nodes: E2BBrowserNode[] = [], action = "browser"): Promise<E2BBrowserRecord> {
    const now = Date.now();
    const activeTabIndex = Number.isSafeInteger(result.activeIndex) && Number(result.activeIndex) >= 0 ? Number(result.activeIndex) : undefined;
    const next: E2BBrowserRecord = {
      ...record,
      ...(typeof result.url === "string" ? { lastUrl: result.url } : {}),
      ...(typeof result.title === "string" ? { title: redactBrowserText(result.title, 160) } : {}),
      ...(typeof result.observationId === "string" ? { observationId: result.observationId } : {}),
      ...(typeof result.pageGeneration === "number" ? { pageGeneration: result.pageGeneration } : {}),
      ...(result.health && typeof result.health === "object" ? { health: result.health } : {}),
      checkpoint: {
        action,
        ...(typeof result.url === "string" ? { url: result.url } : {}),
        ...(typeof result.title === "string" ? { title: redactBrowserText(result.title, 160) } : {}),
        ...(typeof result.observationId === "string" ? { observationId: result.observationId } : {}),
        ...(typeof result.pageGeneration === "number" ? { pageGeneration: result.pageGeneration } : {}),
        ...(typeof result.accessibilityHash === "string" ? { accessibilityHash: result.accessibilityHash } : {}),
        ...(activeTabIndex !== undefined ? { activeTabIndex } : {}),
        ...(Array.isArray(result.tabs) ? { tabs: result.tabs.slice(0, 10).map((tab) => ({ index: Number(tab.index), url: redactBrowserText(tab.url, 2_000), title: redactBrowserText(tab.title, 160), active: tab.active === true })) } : {}),
        verified: action === "snapshot" || action === "state" || action === "find" || action === "form_inspect" || Boolean(result.formState),
        ...(result.workflowCheckpoint ? { ...result.workflowCheckpoint, action: result.workflowCheckpoint.action ?? action } : {}),
        updatedAt: now,
      },
      evidence: [{ action, at: now, ...(typeof result.url === "string" ? { url: result.url } : {}), ...(typeof result.title === "string" ? { title: redactBrowserText(result.title, 160) } : {}), ...(typeof result.observationId === "string" ? { observationId: result.observationId } : {}), ...(typeof result.screenshotHash === "string" ? { screenshotHash: result.screenshotHash } : {}), verified: action === "snapshot" || action === "state" || action === "find" || action === "form_inspect" || Boolean(result.formState) }, ...(record.evidence ?? [])].slice(-50),
      nodes: nodes.length ? nodes : record.nodes,
      updatedAt: now,
      expiresAt: record.sessionId ? record.expiresAt : now + config.e2bTimeoutMs,
      paused: record.paused === true,
    };
    await this.save(userId, next);
    return next;
  }

  private async replanInteraction(userId: number, sandbox: Sandbox, record: E2BBrowserRecord, args: Record<string, unknown>, action: string): Promise<{ record: E2BBrowserRecord; selector: Record<string, unknown> }> {
    const saved = typeof args.nodeId === "string" ? record.nodes?.find((item) => item.nodeId === args.nodeId) : undefined;
    const role = typeof saved?.role === "string" ? saved.role : typeof args.role === "string" ? args.role : undefined;
    const name = typeof saved?.name === "string" ? saved.name : typeof args.name === "string" ? args.name : undefined;
    if (!role || !name) throw new E2BBrowserError("Browser recovery needs the control role and accessible name; inspect the current page before retrying");
    const inspected = await this.run(sandbox, { action: "find", currentUrl: record.lastUrl, role, name, nameMatch: args.nameMatch, limit: 12 });
    const url = typeof inspected.url === "string" ? inspected.url : record.lastUrl ?? "";
    const nodes = normalizeMatches(inspected, url, Date.now());
    const next = await this.persistResult(userId, record, inspected, nodes, "find");
    const sameStableIdentity = (candidate: E2BBrowserNode) => Boolean(saved && ["id", "nameAttr", "placeholder", "autocomplete"].some((key) => {
      const field = key as keyof E2BBrowserNode;
      return typeof saved[field] === "string" && saved[field] === candidate[field];
    }));
    const matching = nodes.filter((candidate) => candidate.role === role && (sameStableIdentity(candidate) || candidate.name === name));
    const candidate = saved && Number.isSafeInteger(saved.index) ? matching.find((item) => item.index === saved.index) ?? (matching.length === 1 ? matching[0] : undefined) : matching.length === 1 ? matching[0] : undefined;
    if (!candidate) throw new E2BBrowserError(`Browser recovery could not safely remap ${action} to a unique current ${role} control named ${name}`);
    return { record: next, selector: selectorForNode(candidate) };
  }

  async workspaceId(userId: number): Promise<string> {
    const existing = await this.record(userId);
    if (existing?.sandboxId) return existing.sandboxId;
    if (config.e2bEnabled && config.e2bApiKey) {
      return (await this.sandbox(userId)).record.sandboxId;
    }
    return `e2b-pending-${userId}`;
  }

  async browser(userId: number, args: Record<string, unknown>, internal: { vaultLoginFlow?: boolean; ownerPrivateRun?: boolean; ownerApprovedAction?: boolean } = {}): Promise<unknown> {
    return withUserLock(userId, async () => {
      await this.purgeExpiredBrowserFiles(userId);
      const action = safeAction(args.action);
      if (["clipboard_read", "clipboard_write"].includes(action)) {
        if (!internal.ownerPrivateRun) throw new E2BBrowserError("Clipboard access is available only in the owner's private conversation");
        if (!internal.ownerApprovedAction) throw new E2BBrowserError("Clipboard access requires owner approval");
      }
      if (action === "session_list") {
        const record = await this.record(userId);
        return { provider: "e2b", sandboxId: record?.sandboxId, sessions: record?.sessionId ? [{ id: record.sessionId, expiresAt: record.expiresAt }] : [] };
      }
      if (action === "session_acquire") {
        const { record } = await this.sandbox(userId);
        const ttlSeconds = Math.max(60, Math.min(3_600, Math.floor(Number(args.ttlSeconds ?? 900))));
        const requestedSessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
        if (requestedSessionId && !/^br_[A-Za-z0-9_-]{1,116}$/.test(requestedSessionId)) throw new E2BBrowserError("sessionId must be a Chusky browser lease ID");
        const sessionId = requestedSessionId || `br_${randomUUID()}`;
        const next = { ...record, sessionId, updatedAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 };
        await this.save(userId, next);
        return { provider: "e2b", sandboxId: next.sandboxId, sessionId, action, expiresAt: next.expiresAt };
      }
      if (action === "session_release") {
        const record = await this.record(userId);
        if (!record?.sessionId || record.sessionId !== args.sessionId) throw new E2BBrowserError("E2B browser session lease not found or already expired");
        await this.save(userId, { ...record, sessionId: undefined, updatedAt: Date.now() });
        return { provider: "e2b", sandboxId: record.sandboxId, sessionId: record.sessionId, released: true };
      }
      if (action === "pause") {
        const { sandbox, record } = await this.sandbox(userId);
        await sandbox.pause({ keepMemory: true });
        const next = { ...record, paused: true, updatedAt: Date.now() };
        await this.save(userId, next);
        return { provider: "e2b", sandboxId: record.sandboxId, action, paused: true, resumable: true };
      }
      if (action === "fork") {
        await guardVaultBrowserAction(userId, (await this.record(userId))?.sandboxId ?? "", { ...args, currentUrl: (await this.record(userId))?.lastUrl }, internal.ownerPrivateRun, internal.ownerApprovedAction);
        const { record } = await this.sandbox(userId);
        const count = Math.max(1, Math.min(4, Math.floor(Number(args.count ?? 1))));
        const forks = await Sandbox.fork(record.sandboxId, { count, timeoutMs: config.e2bTimeoutMs, apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
        return { provider: "e2b", sandboxId: record.sandboxId, action, forks: forks.map((fork) => fork instanceof Sandbox ? { sandboxId: fork.sandboxId } : { error: redactBrowserText(fork instanceof Error ? fork.message : String(fork), 300) }) };
      }
      if (action === "stop") {
        const record = await this.record(userId);
        if (record?.sandboxId) await Sandbox.kill(record.sandboxId, { apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
        await this.save(userId, undefined);
        return { provider: "e2b", action, stopped: true };
      }
      if (action === "status") {
        const record = await this.record(userId);
        if (!record?.sandboxId || record.expiresAt <= Date.now()) {
          return { provider: "e2b", action, status: "stopped" };
        }
        try {
          const { sandbox } = await this.sandbox(userId, false);
          const health = await this.run(sandbox, { action: "health" });
          return { provider: "e2b", sandboxId: record.sandboxId, lastUrl: record.lastUrl, title: record.title, sessionId: record.sessionId, expiresAt: record.expiresAt, health: health.health ?? health };
        } catch (error) {
          return { provider: "e2b", sandboxId: record.sandboxId, lastUrl: record.lastUrl, title: record.title, sessionId: record.sessionId, expiresAt: record.expiresAt, health: { status: "unhealthy", error: redactBrowserText(error instanceof Error ? error.message : String(error), 400) } };
        }
      }
      if (["download_get", "recording_download", "recording_get"].includes(action)) {
        if (!internal.ownerPrivateRun) throw new E2BBrowserError("Private browser files can only be retrieved in the owner's private conversation");
        const file = await this.browserFile(userId, args.fileId ?? args.recordingId ?? args.downloadId, action === "recording_download" || action === "recording_get" ? "recording" : "download");
        return action === "recording_get"
          ? { provider: "e2b", action, fileId: file.id, name: file.name, size: file.size, contentType: file.contentType, createdAt: file.createdAt, expiresAt: file.expiresAt }
          : { provider: "e2b", action, __browserFileId: file.id, name: file.name, size: file.size, contentType: file.contentType, kind: file.kind };
      }
      if (["download_delete", "recording_delete"].includes(action)) {
        if (!internal.ownerPrivateRun) throw new E2BBrowserError("Private browser files can only be deleted from the owner's private conversation");
        if (!internal.ownerApprovedAction) throw new E2BBrowserError("Deleting a private browser file requires owner approval");
        const file = await this.browserFile(userId, args.fileId ?? args.recordingId ?? args.downloadId, action === "recording_delete" ? "recording" : "download");
        await deleteR2Object(file.key);
        const session = await getSession(userId);
        session.browserFiles = (session.browserFiles ?? []).filter((item) => item.id !== file.id);
        await saveSession(userId, session);
        return { provider: "e2b", action, deleted: true, name: file.name };
      }
      const fileLibraryKind = action === "downloads" || action === "download_register"
        ? "download"
        : action === "recording_list" ? "recording" : undefined;
      if (fileLibraryKind) {
        if (!internal.ownerPrivateRun) throw new E2BBrowserError("The private browser file library is available only in the owner's private conversation");
        const record = await this.record(userId);
        let runtimeError: string | undefined;
        if (record?.sandboxId && record.expiresAt > Date.now()) {
          try {
            const { sandbox, record: active } = await this.sandbox(userId, false);
            await this.syncRuntimeFiles(userId, sandbox, active, fileLibraryKind);
          } catch (error) {
            runtimeError = error instanceof Error ? redactBrowserText(error.message, 300) : "The live browser file list is temporarily unavailable";
          }
        }
        const files = (await this.storedBrowserFiles(userId, fileLibraryKind)).map((file) => ({
          id: file.id, fileId: file.id, name: file.name, state: "ready", size: file.size,
          contentType: file.contentType, kind: file.kind, createdAt: file.createdAt, expiresAt: file.expiresAt,
        }));
        return { provider: "e2b", action, ...(fileLibraryKind === "download" ? { downloads: files } : { recordings: files }), ...(runtimeError ? { runtimeStatus: "unavailable", runtimeError } : {}) };
      }
      const { sandbox } = await this.sandbox(userId);
      let record = (await this.record(userId))!;
      let compositeRequest: Record<string, unknown> | undefined;
      if (action === "start" || action === "resume") {
        const next = { ...record, paused: false, updatedAt: Date.now() };
        await this.save(userId, next);
        return { provider: "e2b", sandboxId: record.sandboxId, action, started: true, resumed: action === "resume", expiresAt: record.expiresAt };
      }
      if (action === "form_plan" || action === "form_fill") {
        const inspected = await this.run(sandbox, { action: "form_inspect", currentUrl: record.lastUrl, includePageContent: internal.ownerPrivateRun === true });
        const forms = Array.isArray(inspected.forms) ? inspected.forms : [];
        const plan = planFormSubmission(forms, requestedFormFields(args.fields), typeof args.formId === "string" ? args.formId : undefined);
        record = await this.persistResult(userId, record, inspected, normalizeMatches(inspected, inspected.url ?? record.lastUrl ?? "", Date.now()), "form_inspect");
        if (action === "form_plan") return { provider: "e2b", action, plan, checkpoint: record.checkpoint };
        if (plan.missing.length) return { provider: "e2b", action, plan, checkpoint: { action, formId: plan.formId, pendingControls: plan.missing, nextAction: "Provide values for the missing form fields and retry form_fill", updatedAt: Date.now() } };
        const requestControls = plan.controls.map((control) => ({ role: control.role, name: control.name, ...(control.id ? { id: control.id } : {}), ...(control.frameIndex !== undefined ? { frameIndex: control.frameIndex } : {}), ...(control.frameUrl ? { frameUrl: control.frameUrl } : {}), action: control.action, ...(control.value !== undefined ? { value: control.value } : {}), ...(control.checked !== undefined ? { checked: control.checked } : {}) }));
        compositeRequest = { action: "form_fill", controls: requestControls, submit: args.submit === true, submitControl: plan.submit, formId: plan.formId };
      }
      if (action === "windows") return { provider: "e2b", sandboxId: record.sandboxId, windows: [{ title: record.title ?? "Chromium", url: record.lastUrl ?? "about:blank" }] };
      if (action === "display_info") return { provider: "e2b", sandboxId: record.sandboxId, width: 1440, height: 900 };
      if (["screenshot", "screenshot_full", "screenshot_region", "screenshot_region_full", "recording_start", "recording_stop", "recording_get"].includes(action) && !internal.ownerPrivateRun) {
        throw new E2BBrowserError("Screenshots and browser recordings are available only in the owner's private conversation");
      }
      if (record.sessionId && !["state", "snapshot", "find", "form_inspect", "form_plan"].includes(action) && args.sessionId !== record.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before steering this browser");
      if (!internal.vaultLoginFlow) assertE2BBrowserHandoffAllowsAction(action, (await getSession(userId)).browserHandoffs ?? [], record.lastUrl, record.sandboxId);
      if (!internal.vaultLoginFlow) await guardVaultBrowserAction(userId, record.sandboxId, { ...args, currentUrl: record.lastUrl }, internal.ownerPrivateRun, internal.ownerApprovedAction);
      const request: Record<string, unknown> = compositeRequest ?? auxiliaryBrowserRequest(action, args);
      if (action === "open") request.url = (await assertSafeBrowserUrl(args.url)).toString();
      if (action === "find") Object.assign(request, { role: args.role, name: args.name, nameMatch: args.nameMatch, limit: args.limit });
      if (action !== "open" && record.lastUrl) request.currentUrl = record.lastUrl;
      if (["state", "snapshot", "find", "form_inspect", "open", "wait", "back", "forward", "refresh"].includes(action)) request.includePageContent = internal.ownerPrivateRun === true;
      if ((INTERACTIVE_ACTIONS as readonly string[]).includes(action) && args.nodeId) {
        const saved = record.nodes?.find((item) => item.nodeId === args.nodeId);
        if (!saved || Date.now() - saved.capturedAt > NODE_TTL_MS) throw new E2BBrowserError("E2B browser interaction requires a fresh find/state result");
        Object.assign(request, { selector: selectorForNode(saved), ...(action === "fill" || action === "select_option" ? { value: args.value ?? args.text } : {}) });
      }
      if ((INTERACTIVE_ACTIONS as readonly string[]).includes(action) && !request.selector && (args.role || args.name)) {
        const replanned = await this.replanInteraction(userId, sandbox, record, args, action);
        record = replanned.record;
        Object.assign(request, { selector: replanned.selector, ...(action === "fill" || action === "select_option" ? { value: args.value ?? args.text } : {}) });
      }
      if (action === "upload" || action === "upload_files") {
        if (!internal.ownerPrivateRun) throw new E2BBrowserError("File uploads are available only in the owner's private conversation");
        if (!internal.ownerApprovedAction) throw new E2BBrowserError("Uploading a file to a website requires owner approval");
        if (!args.nodeId || !request.selector) throw new E2BBrowserError("Upload requires a fresh accessible file-input or upload-button node");
        const fileId = boundedText(args.fileId, "fileId", 128);
        const file = (await getSession(userId)).sdkFiles?.find((item) => item.id === fileId && item.status === "available");
        if (!file) throw new E2BBrowserError("Upload file not found or not owned by this account");
        if (file.size < 1 || file.size > MAX_BROWSER_DOWNLOAD_BYTES) throw new E2BBrowserError("The selected upload exceeds the 25 MB browser transfer limit");
        const bytes = await readR2Object(file.key);
        if (bytes.length !== file.size) throw new E2BBrowserError("The stored upload size no longer matches its verified file record");
        const uploadPath = `/tmp/chusky-browser-upload/${randomUUID()}-${normalizeE2BBrowserFileName(file.name)}`;
        await sandbox.files.write(uploadPath, Uint8Array.from(bytes).buffer);
        request.uploadPath = uploadPath;
      }
      if (["click", "move", "type", "press"].includes(action) && !args.nodeId && (args.x !== undefined || args.y !== undefined)) Object.assign(request, { x: Number(args.x), y: Number(args.y) });
      if (action === "type") Object.assign(request, { text: args.text, delayMs: args.delayMs });
      if (action === "press") Object.assign(request, { key: args.key ?? args.keys });
      if (action === "click" && args.visualFallback === true) Object.assign(request, { visualFallback: true, screenshotHash: args.screenshotHash });
      if (action === "drag") {
        const source = record.nodes?.find((item) => item.nodeId === args.startNodeId);
        const target = record.nodes?.find((item) => item.nodeId === args.endNodeId);
        if (!source || !target) throw new E2BBrowserError("E2B drag requires fresh startNodeId and endNodeId results");
        request.source = { role: source.role, name: source.name, index: source.index, frameIndex: source.frameIndex, frameUrl: source.frameUrl, observationId: source.observationId, pageGeneration: source.pageGeneration };
        request.target = { role: target.role, name: target.name, index: target.index, frameIndex: target.frameIndex, frameUrl: target.frameUrl, observationId: target.observationId, pageGeneration: target.pageGeneration };
      }
      if (action === "scroll") Object.assign(request, { direction: args.direction === "up" ? "up" : "down", amount: Math.max(1, Math.min(10, Number(args.amount ?? 3))) });
      if (action === "wait") Object.assign(request, { timeoutMs: Math.max(50, Math.min(30_000, Number(args.timeoutSeconds ?? args.timeoutMs ?? 1_000) * (args.timeoutSeconds ? 1_000 : 1))), ...(args.role ? { role: args.role } : {}), ...(args.name ? { name: args.name, nameMatch: args.nameMatch } : {}) });
      if (action === "tab_focus") request.index = Number(args.index ?? 0);
      if (action === "screenshot_region") Object.assign(request, { x: args.x, y: args.y, width: args.width, height: args.height });
      if (action === "screenshot_region_full") Object.assign(request, { x: args.x, y: args.y, width: args.width, height: args.height });
      if (action === "wait_download") request.timeoutMs = Math.max(100, Math.min(30_000, Number(args.timeoutSeconds ?? args.timeoutMs ?? 10_000) * (args.timeoutSeconds ? 1_000 : 1)));
      if (action === "recording_start") request.durationSeconds = Math.max(10, Math.min(900, Number(args.timeoutSeconds ?? 900)));
      if (action === "recording_stop" || action === "recording_get") request.recordingId = boundedText(args.recordingId ?? args.fileId, "recordingId", 128);
      let result: E2BCommandResult;
      try {
        result = await this.run(sandbox, request);
      } catch (error) {
        // Only replay idempotent control operations. A click, keypress, type,
        // submit, or coordinate action may already have caused an external
        // effect and must be re-inspected by the agent instead.
        const retryable = (SAFE_REPLAN_ACTIONS as readonly string[]).includes(action);
        const retryableCode = error instanceof E2BBrowserError && ["stale_observation", "action_timeout", "browser_action_failed"].includes(error.code);
        if (!retryable || !retryableCode) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const replanned = await this.replanInteraction(userId, sandbox, record, args, action);
        record = replanned.record;
        Object.assign(request, { selector: replanned.selector });
        result = await this.run(sandbox, request);
      }
      let importedFiles: E2BBrowserFileRecord[] = [];
      if (["wait_download"].includes(action)) importedFiles = await this.syncRuntimeFiles(userId, sandbox, record, "download");
      if (action === "pdf" && result.pdf?.filePath && result.pdf.size) {
        const pdf = result.pdf;
        const file = await this.persistRuntimeFile(userId, sandbox, record, { id: `pdf_${createHash("sha256").update(pdf.filePath).digest("hex").slice(0, 24)}`, kind: "download", name: pdf.name, size: pdf.size, createdAt: Date.now(), filePath: pdf.filePath });
        importedFiles = [file];
      }
      if (action === "recording_stop" && result.runtimeFilePath && result.recording?.id && result.recording.size) {
        const file = await this.persistRuntimeFile(userId, sandbox, record, { id: result.recording.id, kind: "recording", name: result.recording.name ?? `${result.recording.id}.mp4`, size: result.recording.size, createdAt: result.recording.createdAt ?? Date.now(), filePath: result.runtimeFilePath });
        importedFiles = [file];
        await this.run(sandbox, { action: "recording_ack", id: result.recording.id });
      }
      if (typeof result.url === "string" && /^https?:$/i.test(new URL(result.url).protocol)) await assertSafeBrowserUrl(result.url);
      const url = typeof result.url === "string" ? result.url : record.lastUrl ?? "";
      const nodes = normalizeMatches(result, url, Date.now());
      const next = await this.persistResult(userId, record, result, nodes, action);
      if (nodes.length) await rememberVaultBrowserNodes(userId, next.sandboxId, nodes, next.lastUrl);
      const safe = { provider: "e2b", sandboxId: next.sandboxId, action, ...(result.observationId ? { observationId: result.observationId } : {}), ...(typeof result.pageGeneration === "number" ? { pageGeneration: result.pageGeneration } : {}), ...(result.accessibilityHash ? { accessibilityHash: result.accessibilityHash } : {}), ...(result.health ? { health: result.health } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}), ...(result.events ? { events: result.events } : {}), ...(result.url ? { observedUrl: result.url, observationMethod: "playwright_page_url" } : {}), ...(result.title ? { title: redactBrowserText(result.title, 160) } : {}), ...(result.loadState ? { loadState: result.loadState } : {}), ...(nodes.length ? { matches: nodes } : {}), ...(result.formState ? { formState: result.formState } : {}), ...(result.actionVerification ? { actionVerification: result.actionVerification } : {}), ...(result.validationErrors ? { validationErrors: result.validationErrors } : {}), ...(typeof result.submitted === "boolean" ? { submitted: result.submitted } : {}), ...(result.workflowCheckpoint ? { workflowCheckpoint: result.workflowCheckpoint } : {}), ...(internal.ownerPrivateRun === true && typeof result.pageContent === "string" ? { pageContent: normalizeE2BPageContent(result.pageContent).text, pageContentTruncated: result.pageContentTruncated === true } : {}), ...(result.download ? { download: result.download } : {}), ...(result.pdf ? { pdf: { name: result.pdf.name, size: result.pdf.size, ...(importedFiles[0] ? { fileId: importedFiles[0].id } : {}) } } : {}), ...(importedFiles.length ? { files: importedFiles.map((file) => ({ fileId: file.id, name: file.name, kind: file.kind, size: file.size, contentType: file.contentType, expiresAt: file.expiresAt })) } : {}), ...(result.recording ? { recording: { id: result.recording.id, name: result.recording.name, state: result.recording.state, size: result.recording.size, createdAt: result.recording.createdAt, ...(importedFiles[0] ? { fileId: importedFiles[0].id } : {}) } } : {}), ...(result.screenshot ? { __browserScreenshot: true, base64: result.screenshot, mediaType: "image/jpeg", sizeBytes: Math.floor(result.screenshot.length * 0.75), ...(typeof result.screenshotId === "string" ? { screenshotId: result.screenshotId } : {}), ...(typeof result.screenshotHash === "string" ? { screenshotHash: result.screenshotHash } : {}) } : {}) };
      Object.assign(safe, result.forms ? { forms: result.forms } : {}, result.desktopAction ? { desktopAction: result.desktopAction } : {}, result.clipboard ? { clipboard: result.clipboard, ...(typeof result.text === "string" ? { text: result.text } : {}) } : {}, next.checkpoint ? { checkpoint: next.checkpoint } : {});
      const challenge = result.challenge && typeof result.challenge === "object" ? result.challenge : undefined;
      const safeWithChallenge = { ...safe, ...(result.needsUserInteraction ? { needsUserInteraction: true } : {}), ...(challenge ? { challenge } : {}), ...(Array.isArray(result.tabs) ? { tabs: result.tabs } : {}) };
      if (action === "state" || action === "snapshot" || action === "form_inspect" || action === "open" || action === "back" || action === "forward" || action === "refresh") {
        return { ...safeWithChallenge, accessibility: { role: "main", children: nodes.map(({ nodeId, role, name, frameIndex, frameUrl, observationId, pageGeneration }) => ({ nodeId, role, name, ...(frameIndex !== undefined ? { frameIndex } : {}), ...(frameUrl ? { frameUrl } : {}), ...(observationId ? { observationId } : {}), ...(pageGeneration !== undefined ? { pageGeneration } : {}) })) }, verificationRequired: !["state", "snapshot", "find", "form_inspect", "health", "status", "start"].includes(action) };
      }
      return { ...safeWithChallenge, verificationRequired: !["state", "snapshot", "find", "health", "status", "start"].includes(action) };
    });
  }

  /**
   * Trusted server-only form fill for payment credentials. This intentionally
   * is not part of the model-facing browser action union: the caller supplies
   * only a fresh node id, while the secret value is injected here and sent to
   * the private browser runtime without entering model arguments or history.
   */
  async secureFill(userId: number, args: { nodeId: string; value: string; sessionId?: unknown }): Promise<{ provider: string; action: string; filled: true }> {
    return withUserLock(userId, async () => {
      const record = await this.record(userId);
      if (!record?.sandboxId || record.expiresAt <= Date.now()) throw new E2BBrowserError("No active E2B browser exists for secure checkout");
      if (record.sessionId && record.sessionId !== args.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before secure checkout");
      const node = record.nodes?.find((item) => item.nodeId === args.nodeId);
      if (!node || Date.now() - node.capturedAt > NODE_TTL_MS) throw new E2BBrowserError("Secure checkout requires a fresh accessible payment-field result");
      if (typeof args.value !== "string" || !args.value || args.value.length > 256) throw new E2BBrowserError("Secure checkout field value is invalid");
      const { sandbox } = await this.sandbox(userId, false);
      await guardVaultBrowserAction(userId, record.sandboxId, { action: "fill", currentUrl: record.lastUrl }, true, true);
      const result = await this.run(sandbox, { action: "fill", currentUrl: record.lastUrl, selector: { role: node.role, name: node.name, index: node.index, frameIndex: node.frameIndex, frameUrl: node.frameUrl, observationId: node.observationId, pageGeneration: node.pageGeneration }, value: args.value });
      await this.persistResult(userId, record, result);
      return { provider: "e2b", action: "secure_fill", filled: true };
    });
  }

  /**
   * Inspect the live checkout for Stripe's Link Pay Token steering markers.
   * The browser runtime returns only the merchant account and a boolean; it
   * never returns the token input value or page source to the model.
   */
  async inspectLinkPayToken(userId: number, args: { sessionId?: unknown } = {}): Promise<Record<string, unknown>> {
    return withUserLock(userId, async () => {
      const record = await this.record(userId);
      if (!record?.sandboxId || record.expiresAt <= Date.now()) throw new E2BBrowserError("No active E2B browser exists for Link checkout");
      if (record.sessionId && record.sessionId !== args.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before Link checkout");
      if (!record.lastUrl || !/^https:\/\//i.test(record.lastUrl)) throw new E2BBrowserError("Link checkout requires an active HTTPS merchant page");
      const { sandbox } = await this.sandbox(userId, false);
      const result = await this.run(sandbox, { action: "link_inspect", currentUrl: record.lastUrl });
      await this.persistResult(userId, record, result);
      const marker = result.linkPayToken && typeof result.linkPayToken === "object" ? result.linkPayToken as Record<string, unknown> : { supported: false };
      return { provider: "e2b", supported: marker.supported === true, ...(typeof marker.merchantAccountId === "string" ? { merchantAccountId: marker.merchantAccountId } : {}), ...(typeof marker.frameUrl === "string" ? { frameUrl: marker.frameUrl } : {}) };
    });
  }

  /** Trusted server-only LPT injection into the verified Stripe frame. */
  async secureLinkPayToken(userId: number, args: { value: string; merchantAccountId: string; sessionId?: unknown }): Promise<{ provider: string; action: string; filled: true }> {
    return withUserLock(userId, async () => {
      const record = await this.record(userId);
      if (!record?.sandboxId || record.expiresAt <= Date.now()) throw new E2BBrowserError("No active E2B browser exists for Link checkout");
      if (record.sessionId && record.sessionId !== args.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before Link checkout");
      if (typeof args.value !== "string" || !args.value || args.value.length > 4096) throw new E2BBrowserError("Link Pay Token is invalid");
      if (!/^acct_[A-Za-z0-9]+$/.test(args.merchantAccountId)) throw new E2BBrowserError("Link merchant account is invalid");
      const { sandbox } = await this.sandbox(userId, false);
      const result = await this.run(sandbox, { action: "link_pay_token_fill", currentUrl: record.lastUrl, expectedMerchantAccountId: args.merchantAccountId, value: args.value });
      await this.persistResult(userId, record, result);
      return { provider: "e2b", action: "secure_link_pay_token", filled: true };
    });
  }

  async browserHandoff(userId: number, reason?: string): Promise<{ sandboxId: string; url: string; expiresAt: number; message: string }> {
    const { sandbox, record } = await this.sandbox(userId);
    const token = randomUUID().replaceAll("-", "").slice(0, 8);
    const requestedTtl = Number(config.e2bBrowserHandoffTtlSeconds);
    const ttlSeconds = Number.isFinite(requestedTtl) ? Math.min(900, Math.max(60, Math.floor(requestedTtl))) : 300;
    const handoffEnv = { DISPLAY: ":99", XDG_RUNTIME_DIR: "/tmp/chusky-runtime" };
    const startHandoffService = async (command: string) => {
      await sandbox.commands.run(command, { envs: handoffEnv, requestTimeoutMs: config.e2bRequestTimeoutMs });
    };
    // Keep the VNC services separate from the browser daemon. The E2B command
    // API treats a detached nested shell as a failed command intermittently,
    // and returning the preview URL before websockify is listening creates a
    // misleading "closed port" handoff.
    await startHandoffService("if [ -f /tmp/chusky-x11vnc.pid ] && kill -0 $(cat /tmp/chusky-x11vnc.pid) 2>/dev/null; then kill $(cat /tmp/chusky-x11vnc.pid) 2>/dev/null || true; fi; pkill -x x11vnc 2>/dev/null || true; rm -f /tmp/chusky-x11vnc.pid");
    await startHandoffService("if [ -f /tmp/chusky-websockify.pid ] && kill -0 $(cat /tmp/chusky-websockify.pid) 2>/dev/null; then kill $(cat /tmp/chusky-websockify.pid) 2>/dev/null || true; fi; pkill -x websockify 2>/dev/null || true; rm -f /tmp/chusky-websockify.pid");
    await startHandoffService(`nohup x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwd ${token} >/tmp/chusky-x11vnc.log 2>&1 & echo $! >/tmp/chusky-x11vnc.pid`);
    let lastError = "x11vnc did not become ready";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = await sandbox.commands.run("node -e \"const net=require('node:net'); const s=net.createConnection({host:'127.0.0.1',port:5900}); s.once('connect',()=>{console.log('ready');s.end()}); s.once('error',()=>console.log('not-ready')); setTimeout(()=>{s.destroy();console.log('not-ready')},1000)\"", { timeoutMs: 2_000, requestTimeoutMs: config.e2bRequestTimeoutMs });
      if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).includes("ready")) break;
      lastError = (probe.stderr || probe.stdout || lastError).trim().slice(0, 300);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (attempt === 19) throw new E2BBrowserError(`E2B VNC service did not become ready: ${lastError}`);
    }
    await startHandoffService(`nohup websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/chusky-websockify.log 2>&1 & echo $! >/tmp/chusky-websockify.pid`);
    lastError = "websockify did not become ready";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = await sandbox.commands.run("node -e \"fetch('http://127.0.0.1:6080/vnc.html').then(async r=>{console.log(r.ok?'ready':'not-ready');await r.arrayBuffer()}).catch(()=>console.log('not-ready'))\"", { timeoutMs: 2_000, requestTimeoutMs: config.e2bRequestTimeoutMs });
      if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).at(-1) === "ready") break;
      lastError = (probe.stderr || probe.stdout || lastError).trim().slice(0, 300);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (attempt === 19) throw new E2BBrowserError(`E2B handoff service did not become ready: ${lastError}`);
    }
    await startHandoffService(`nohup sh -lc "sleep ${ttlSeconds}; if [ -f /tmp/chusky-x11vnc.pid ]; then kill $(cat /tmp/chusky-x11vnc.pid) 2>/dev/null || true; fi; if [ -f /tmp/chusky-websockify.pid ]; then kill $(cat /tmp/chusky-websockify.pid) 2>/dev/null || true; fi" >/dev/null 2>&1 &`);
    const host = sandbox.getHost(6080);
    const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    // noVNC explicitly supports config in the URL fragment. Keep the VNC
    // password out of HTTP requests, reverse-proxy access logs, and referrers.
    const url = `${base.replace(/\/$/, "")}/vnc.html#autoconnect=1&resize=scale&password=${encodeURIComponent(token)}`;
    return { sandboxId: record.sandboxId, url, expiresAt: Date.now() + ttlSeconds * 1000, message: `Open this private browser session to complete ${reason || "the website step"}. It expires soon. When you are done, return here and say continue; Chusky will inspect the same retained browser before it does anything else.` };
  }

  async vaultLogin(userId: number, input: { origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string; loginRecipe?: { steps?: Array<{ role?: string; name?: string; action?: string }>; failure?: Array<{ textIncludes?: string }> } }): Promise<{ workspaceId: string; authenticated: boolean; needsUserInteraction?: boolean; handoffOrigin?: string }> {
    // Credentials arrive only from the broker. They are sent to the trusted
    // E2B process as an environment value for one command and are never
    // returned, logged, or persisted by this adapter.
    const login = new URL(input.loginUrl);
    if (login.origin !== input.origin || login.protocol !== "https:") throw new E2BBrowserError("Vault login URL does not match its authorised origin");
    const { sandbox, record } = await this.sandbox(userId);
    const result = await this.run(sandbox, { action: "vault_login", url: login.toString(), usernameFieldLabel: input.usernameFieldLabel, passwordFieldLabel: input.passwordFieldLabel, submitButtonLabel: input.submitButtonLabel, username: input.username, password: input.password, loginRecipe: input.loginRecipe, currentUrl: record.lastUrl });
    const next = await this.persistResult(userId, record, result);
    let handoffOrigin: string | undefined;
    if (result.needsUserInteraction === true && typeof result.url === "string") {
      try { const observed = new URL(result.url); if (observed.protocol === "https:") handoffOrigin = observed.origin; } catch { /* ignore invalid page URL */ }
    }
    return { workspaceId: next.sandboxId, authenticated: result.authenticated === true, ...(result.needsUserInteraction === true ? { needsUserInteraction: true } : {}), ...(handoffOrigin ? { handoffOrigin } : {}) };
  }
}

export const e2bBrowserEngine = new E2BBrowserEngine();
