import { Sandbox } from "e2b";
import { randomUUID, createHash } from "node:crypto";
import { config } from "../../config.js";
import { getSession, saveSession } from "../../store.js";
import { guardVaultBrowserAction, rememberVaultBrowserNodes } from "../../vault/browserGuard.js";
import { redactBrowserText } from "../../vault/browserObservation.js";
import { DaytonaInputError } from "../daytona/errors.js";
import type { E2BBrowserAction, E2BBrowserNode, E2BBrowserRecord, E2BCommandResult } from "./types.js";

const MAX_OUTPUT = 16_000;
const MAX_NODES = 60;
const NODE_TTL_MS = 2 * 60_000;
const locks = new Map<number, Promise<void>>();

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DaytonaInputError(`${field} must be 1-${max} characters`);
  return value.trim();
}

function safeAction(value: unknown): E2BBrowserAction {
  const action = boundedText(value, "action", 32) as E2BBrowserAction;
  const allowed: E2BBrowserAction[] = ["start", "stop", "status", "state", "session_acquire", "session_list", "session_release", "open", "snapshot", "find", "focus", "invoke", "fill", "click", "move", "drag", "type", "press", "select_option", "check", "uncheck", "hover", "wait", "screenshot", "screenshot_full", "screenshot_region", "windows", "display_info", "tabs", "tab_open", "tab_focus", "tab_close", "back", "forward", "refresh", "scroll"];
  if (!allowed.includes(action)) throw new DaytonaInputError(`Unsupported E2B browser action: ${action}`);
  return action;
}

function validateUrl(value: unknown): string {
  const raw = boundedText(value, "url", 2_000);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new DaytonaInputError("Browser URL must be a valid http(s) URL"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new DaytonaInputError("Browser URL must use http(s) without embedded credentials");
  return parsed.toString();
}

function nodeId(role: string, name: string, index: number): string {
  return `e2b_${createHash("sha256").update(`${role}\0${name}\0${index}`).digest("hex").slice(0, 28)}`;
}

function encodeRequest(request: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function parseResult(stdout: string, stderr: string): E2BCommandResult {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new DaytonaInputError(`E2B browser returned no result${stderr ? `: ${redactBrowserText(stderr, 500)}` : ""}`);
  try { return JSON.parse(line) as E2BCommandResult; }
  catch { throw new DaytonaInputError(`E2B browser returned invalid result${stderr ? `: ${redactBrowserText(stderr, 500)}` : ""}`); }
}

function normalizeMatches(raw: E2BCommandResult, url: string, now: number): E2BBrowserNode[] {
  return (Array.isArray(raw.matches) ? raw.matches : []).slice(0, MAX_NODES).flatMap((item) => {
    const role = redactBrowserText(item?.role, 40).toLowerCase();
    const name = redactBrowserText(item?.name, 160);
    const index = Number(item?.index);
    if (!role || !name || !Number.isSafeInteger(index) || index < 0) return [];
    return [{ nodeId: nodeId(role, name, index), role, name, index, url, capturedAt: now }];
  });
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
    if (!config.e2bEnabled || !config.e2bApiKey) throw new DaytonaInputError("E2B browser is disabled. Configure E2B_ENABLED=true and E2B_API_KEY.");
    const prior = await this.record(userId);
    const now = Date.now();
    if (prior?.sandboxId && prior.expiresAt > now) {
      try {
        const sandbox = await Sandbox.connect(prior.sandboxId, { apiKey: config.e2bApiKey, requestTimeoutMs: config.e2bRequestTimeoutMs });
        await sandbox.setTimeout(config.e2bTimeoutMs, { requestTimeoutMs: config.e2bRequestTimeoutMs });
        await this.ensureRuntime(sandbox);
        return { sandbox, record: prior };
      } catch (error) {
        if (!create) throw error;
      }
    }
    if (!create) throw new DaytonaInputError("No active E2B browser sandbox exists. Start the browser first.");
    const expiresAt = now + config.e2bTimeoutMs;
    const sandbox = await Sandbox.create(config.e2bBrowserTemplate, {
      apiKey: config.e2bApiKey,
      timeoutMs: config.e2bTimeoutMs,
      requestTimeoutMs: config.e2bRequestTimeoutMs,
      allowInternetAccess: true,
      metadata: { app: "chusky", surface: "browser", owner: String(userId) },
    });
    const next: E2BBrowserRecord = { sandboxId: sandbox.sandboxId, createdAt: now, updatedAt: now, expiresAt };
    await this.ensureRuntime(sandbox);
    await this.save(userId, next);
    return { sandbox, record: next };
  }

  private async ensureRuntime(sandbox: Sandbox): Promise<void> {
    await sandbox.commands.run("bash -lc 'if [ ! -f /tmp/chusky-xvfb.pid ] || ! kill -0 $(cat /tmp/chusky-xvfb.pid) 2>/dev/null; then nohup Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/chusky-xvfb.log 2>&1 & echo $! >/tmp/chusky-xvfb.pid; fi; if [ ! -f /tmp/chusky-fluxbox.pid ] || ! kill -0 $(cat /tmp/chusky-fluxbox.pid) 2>/dev/null; then nohup fluxbox >/tmp/chusky-fluxbox.log 2>&1 & echo $! >/tmp/chusky-fluxbox.pid; fi; if [ ! -f /tmp/chusky-browser.pid ] || ! kill -0 $(cat /tmp/chusky-browser.pid) 2>/dev/null; then DISPLAY=:99 nohup node /app/browser-agent.mjs --server >/tmp/chusky-browser.log 2>&1 & echo $! >/tmp/chusky-browser.pid; fi'", { background: true, requestTimeoutMs: config.e2bRequestTimeoutMs });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  private async run(sandbox: Sandbox, request: Record<string, unknown>): Promise<E2BCommandResult> {
    const result = await sandbox.commands.run("node /app/browser-client.mjs", {
      cwd: "/app",
      envs: { CHUSKY_E2B_REQUEST_B64: encodeRequest(request) },
      timeoutMs: Math.min(config.e2bRequestTimeoutMs, 60_000),
      requestTimeoutMs: config.e2bRequestTimeoutMs,
    });
    if (result.exitCode !== 0) throw new DaytonaInputError(`E2B browser action failed: ${redactBrowserText(result.stderr || result.stdout, 800)}`);
    return parseResult(result.stdout, result.stderr);
  }

  private async persistResult(userId: number, record: E2BBrowserRecord, result: E2BCommandResult, nodes: E2BBrowserNode[] = []): Promise<E2BBrowserRecord> {
    const now = Date.now();
    const next: E2BBrowserRecord = {
      ...record,
      ...(typeof result.url === "string" ? { lastUrl: result.url } : {}),
      ...(typeof result.title === "string" ? { title: redactBrowserText(result.title, 160) } : {}),
      nodes: nodes.length ? nodes : record.nodes,
      updatedAt: now,
      expiresAt: record.sessionId ? record.expiresAt : now + config.e2bTimeoutMs,
    };
    await this.save(userId, next);
    return next;
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
      const action = safeAction(args.action);
      if (action === "session_list") {
        const record = await this.record(userId);
        return { provider: "e2b", sandboxId: record?.sandboxId, sessions: record?.sessionId ? [{ id: record.sessionId, expiresAt: record.expiresAt }] : [] };
      }
      if (action === "session_acquire") {
        const { record } = await this.sandbox(userId);
        const ttlSeconds = Math.max(60, Math.min(3_600, Math.floor(Number(args.ttlSeconds ?? 900))));
        const sessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : `br_${randomUUID()}`;
        const next = { ...record, sessionId, updatedAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 };
        await this.save(userId, next);
        return { provider: "e2b", sandboxId: next.sandboxId, sessionId, action, expiresAt: next.expiresAt };
      }
      if (action === "session_release") {
        const record = await this.record(userId);
        if (!record?.sessionId || record.sessionId !== args.sessionId) throw new DaytonaInputError("E2B browser session lease not found or already expired");
        await this.save(userId, { ...record, sessionId: undefined, updatedAt: Date.now() });
        return { provider: "e2b", sandboxId: record.sandboxId, sessionId: record.sessionId, released: true };
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
        return { provider: "e2b", sandboxId: record.sandboxId, lastUrl: record.lastUrl, title: record.title, sessionId: record.sessionId, expiresAt: record.expiresAt };
      }
      const { sandbox, record } = await this.sandbox(userId);
      if (action === "start") return { provider: "e2b", sandboxId: record.sandboxId, action, started: true, expiresAt: record.expiresAt };
      if (action === "windows") return { provider: "e2b", sandboxId: record.sandboxId, windows: [{ title: record.title ?? "Chromium", url: record.lastUrl ?? "about:blank" }] };
      if (action === "display_info") return { provider: "e2b", sandboxId: record.sandboxId, width: 1440, height: 900 };
      if (record.sessionId && action !== "state" && action !== "snapshot" && args.sessionId !== record.sessionId) throw new DaytonaInputError("Acquire the active E2B browser session lease before steering this browser");
      if (!internal.vaultLoginFlow) await guardVaultBrowserAction(userId, record.sandboxId, { ...args, currentUrl: record.lastUrl }, internal.ownerPrivateRun, internal.ownerApprovedAction);
      const request: Record<string, unknown> = { action };
      if (action === "open") request.url = validateUrl(args.url);
      if (action === "find") Object.assign(request, { role: args.role, name: args.name, nameMatch: args.nameMatch, limit: args.limit });
      if (action !== "open" && record.lastUrl) request.currentUrl = record.lastUrl;
      if (["invoke", "fill", "focus", "click", "move", "hover", "select_option", "check", "uncheck", "type", "press"].includes(action) && args.nodeId) {
        const saved = record.nodes?.find((item) => item.nodeId === args.nodeId);
        if (!saved || Date.now() - saved.capturedAt > NODE_TTL_MS) throw new DaytonaInputError("E2B browser interaction requires a fresh find/state result");
        Object.assign(request, { selector: { role: saved.role, name: saved.name, index: saved.index }, ...(action === "fill" || action === "select_option" ? { value: args.value ?? args.text } : {}) });
      }
      if (["click", "move", "type", "press"].includes(action) && !args.nodeId && (args.x !== undefined || args.y !== undefined)) Object.assign(request, { x: Number(args.x), y: Number(args.y) });
      if (action === "type") Object.assign(request, { text: args.text, delayMs: args.delayMs });
      if (action === "press") Object.assign(request, { key: args.key ?? args.keys });
      if (action === "drag") {
        const source = record.nodes?.find((item) => item.nodeId === args.startNodeId);
        const target = record.nodes?.find((item) => item.nodeId === args.endNodeId);
        if (!source || !target) throw new DaytonaInputError("E2B drag requires fresh startNodeId and endNodeId results");
        request.source = { role: source.role, name: source.name, index: source.index };
        request.target = { role: target.role, name: target.name, index: target.index };
      }
      if (action === "scroll") Object.assign(request, { direction: args.direction === "up" ? "up" : "down", amount: Math.max(1, Math.min(10, Number(args.amount ?? 3))) });
      if (action === "wait") request.timeoutMs = Math.max(50, Math.min(30_000, Number(args.timeoutSeconds ?? args.timeoutMs ?? 1_000) * (args.timeoutSeconds ? 1_000 : 1)));
      if (action === "tab_focus") request.index = Number(args.index ?? 0);
      if (action === "screenshot_region") Object.assign(request, { x: args.x, y: args.y, width: args.width, height: args.height });
      const result = await this.run(sandbox, request);
      const url = typeof result.url === "string" ? result.url : record.lastUrl ?? "";
      const nodes = normalizeMatches(result, url, Date.now());
      const next = await this.persistResult(userId, record, result, nodes);
      if (nodes.length) await rememberVaultBrowserNodes(userId, next.sandboxId, nodes, next.lastUrl);
      const safe = { provider: "e2b", sandboxId: next.sandboxId, action, ...(result.url ? { observedUrl: result.url } : {}), ...(result.title ? { title: redactBrowserText(result.title, 160) } : {}), ...(result.loadState ? { loadState: result.loadState } : {}), ...(nodes.length ? { matches: nodes } : {}), ...(result.screenshot ? { __daytonaScreenshot: true, base64: result.screenshot, mediaType: "image/jpeg", sizeBytes: Math.floor(result.screenshot.length * 0.75) } : {}) };
      const challenge = result.challenge && typeof result.challenge === "object" ? result.challenge : undefined;
      const safeWithChallenge = { ...safe, ...(result.needsUserInteraction ? { needsUserInteraction: true } : {}), ...(challenge ? { challenge } : {}), ...(Array.isArray(result.tabs) ? { tabs: result.tabs } : {}) };
      if (action === "state" || action === "snapshot" || action === "open" || action === "back" || action === "forward" || action === "refresh") {
        return { ...safeWithChallenge, accessibility: { role: "main", children: nodes.map(({ nodeId, role, name }) => ({ nodeId, role, name })) }, verificationRequired: action !== "state" };
      }
      return safeWithChallenge;
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
      if (!record?.sandboxId || record.expiresAt <= Date.now()) throw new DaytonaInputError("No active E2B browser exists for secure checkout");
      if (record.sessionId && record.sessionId !== args.sessionId) throw new DaytonaInputError("Acquire the active E2B browser session lease before secure checkout");
      const node = record.nodes?.find((item) => item.nodeId === args.nodeId);
      if (!node || Date.now() - node.capturedAt > NODE_TTL_MS) throw new DaytonaInputError("Secure checkout requires a fresh accessible payment-field result");
      if (typeof args.value !== "string" || !args.value || args.value.length > 256) throw new DaytonaInputError("Secure checkout field value is invalid");
      const { sandbox } = await this.sandbox(userId, false);
      await guardVaultBrowserAction(userId, record.sandboxId, { action: "fill", currentUrl: record.lastUrl }, true, true);
      const result = await this.run(sandbox, { action: "fill", currentUrl: record.lastUrl, selector: { role: node.role, name: node.name, index: node.index }, value: args.value });
      await this.persistResult(userId, record, result);
      return { provider: "e2b", action: "secure_fill", filled: true };
    });
  }

  async browserHandoff(userId: number, reason?: string): Promise<{ sandboxId: string; url: string; expiresAt: number; message: string }> {
    const { sandbox, record } = await this.sandbox(userId);
    const token = randomUUID().replaceAll("-", "").slice(0, 8);
    const requestedTtl = Number(config.daytonaBrowserHandoffTtlSeconds);
    const ttlSeconds = Number.isFinite(requestedTtl) ? Math.min(900, Math.max(60, Math.floor(requestedTtl))) : 300;
    await sandbox.commands.run(`bash -lc 'pkill -f "x11vnc.*-rfbport 5900" 2>/dev/null || true; pkill -f "websockify.*6080" 2>/dev/null || true; DISPLAY=:99 nohup x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwd ${token} >/tmp/chusky-x11vnc.log 2>&1 & nohup websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/chusky-websockify.log 2>&1 & nohup sh -lc "sleep ${ttlSeconds}; pkill -f \\\"x11vnc.*-rfbport 5900\\\" 2>/dev/null || true; pkill -f \\\"websockify.*6080\\\" 2>/dev/null || true" >/dev/null 2>&1 &'`, { background: true, requestTimeoutMs: config.e2bRequestTimeoutMs });
    const host = sandbox.getHost(6080);
    const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    const url = `${base.replace(/\/$/, "")}/vnc.html?autoconnect=1&resize=remote&password=${encodeURIComponent(token)}`;
    return { sandboxId: record.sandboxId, url, expiresAt: Date.now() + ttlSeconds * 1000, message: `Open this private browser session to complete ${reason || "the website step"}. It expires soon. When you are done, return here and say continue; Chusky will inspect the same retained browser before it does anything else.` };
  }

  async vaultLogin(userId: number, input: { origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string; loginRecipe?: { steps?: Array<{ role?: string; name?: string; action?: string }>; failure?: Array<{ textIncludes?: string }> } }): Promise<{ workspaceId: string; authenticated: boolean; needsUserInteraction?: boolean }> {
    // Credentials arrive only from the broker. They are sent to the trusted
    // E2B process as an environment value for one command and are never
    // returned, logged, or persisted by this adapter.
    const login = new URL(input.loginUrl);
    if (login.origin !== input.origin || login.protocol !== "https:") throw new DaytonaInputError("Vault login URL does not match its authorised origin");
    const { sandbox, record } = await this.sandbox(userId);
    const result = await this.run(sandbox, { action: "vault_login", url: login.toString(), usernameFieldLabel: input.usernameFieldLabel, passwordFieldLabel: input.passwordFieldLabel, submitButtonLabel: input.submitButtonLabel, username: input.username, password: input.password, loginRecipe: input.loginRecipe, currentUrl: record.lastUrl });
    const next = await this.persistResult(userId, record, result);
    return { workspaceId: next.sandboxId, authenticated: result.authenticated === true, ...(result.needsUserInteraction === true ? { needsUserInteraction: true } : {}) };
  }
}

export const e2bBrowserEngine = new E2BBrowserEngine();
