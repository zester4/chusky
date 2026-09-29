import { Sandbox } from "e2b";
import { randomUUID, createHash } from "node:crypto";
import { config } from "../../config.js";
import { getSession, saveSession } from "../../store.js";
import { guardVaultBrowserAction, rememberVaultBrowserNodes } from "../../vault/browserGuard.js";
import { redactBrowserText } from "../../vault/browserObservation.js";
import { assertE2BBrowserHandoffAllowsAction, normalizeE2BBrowserFileName, normalizeE2BPageContent } from "./contracts.js";
import { E2BBrowserError } from "./errors.js";
import { assertSafeBrowserUrl } from "./urlSafety.js";
import { deleteR2Object, putR2Object, r2Configured, readR2Object } from "../../lib/storage/r2.js";
import { E2B_BROWSER_ACTIONS, type E2BBrowserAction, type E2BBrowserFileRecord, type E2BBrowserNode, type E2BBrowserRecord, type E2BCommandResult } from "./types.js";

const MAX_OUTPUT = 16_000;
const MAX_NODES = 60;
const NODE_TTL_MS = 2 * 60_000;
const MAX_BROWSER_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BROWSER_RECORDING_BYTES = 100 * 1024 * 1024;
const BROWSER_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRIVATE_EGRESS_CIDRS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8",
];
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

function nodeId(role: string, name: string, index: number): string {
  return `e2b_${createHash("sha256").update(`${role}\0${name}\0${index}`).digest("hex").slice(0, 28)}`;
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
    if (!config.e2bEnabled || !config.e2bApiKey) throw new E2BBrowserError("E2B browser is disabled. Configure E2B_ENABLED=true and E2B_API_KEY.");
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
      network: { allowPublicTraffic: true, denyOut: PRIVATE_EGRESS_CIDRS },
      metadata: { app: "chusky", surface: "browser", owner: String(userId) },
    });
    const next: E2BBrowserRecord = { sandboxId: sandbox.sandboxId, createdAt: now, updatedAt: now, expiresAt };
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
      const probe = await sandbox.commands.run("node -e \"fetch('http://127.0.0.1:8765/health').then(async r => { console.log(r.ok ? 'ready' : 'not-ready'); await r.text(); }).catch(() => console.log('not-ready'))\"", { timeoutMs: 5_000, requestTimeoutMs: config.e2bRequestTimeoutMs });
      if (probe.exitCode === 0 && probe.stdout.trim().split(/\r?\n/).at(-1) === "ready") return;
      lastError = (probe.stderr || probe.stdout || lastError).trim().slice(0, 300);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new E2BBrowserError(`E2B browser daemon did not become ready: ${lastError}`);
  }

  private async run(sandbox: Sandbox, request: Record<string, unknown>): Promise<E2BCommandResult> {
    const result = await sandbox.commands.run("node /app/browser-client.mjs", {
      cwd: "/app",
      envs: { CHUSKY_E2B_REQUEST_B64: encodeRequest(request) },
      timeoutMs: Math.min(config.e2bRequestTimeoutMs, 60_000),
      requestTimeoutMs: config.e2bRequestTimeoutMs,
    });
    if (result.exitCode !== 0) throw new E2BBrowserError(`E2B browser action failed: ${redactBrowserText(result.stderr || result.stdout, 800)}`);
    const parsed = parseResult(result.stdout, result.stderr);
    if (parsed.ok !== true) throw new E2BBrowserError(redactBrowserText(parsed.error || "E2B browser action failed", 800));
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
      await this.purgeExpiredBrowserFiles(userId);
      const action = safeAction(args.action);
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
      const { sandbox, record } = await this.sandbox(userId);
      if (action === "start") return { provider: "e2b", sandboxId: record.sandboxId, action, started: true, expiresAt: record.expiresAt };
      if (action === "windows") return { provider: "e2b", sandboxId: record.sandboxId, windows: [{ title: record.title ?? "Chromium", url: record.lastUrl ?? "about:blank" }] };
      if (action === "display_info") return { provider: "e2b", sandboxId: record.sandboxId, width: 1440, height: 900 };
      if (["screenshot", "screenshot_full", "screenshot_region", "screenshot_region_full", "recording_start", "recording_stop", "recording_get"].includes(action) && !internal.ownerPrivateRun) {
        throw new E2BBrowserError("Screenshots and browser recordings are available only in the owner's private conversation");
      }
      if (record.sessionId && action !== "state" && action !== "snapshot" && args.sessionId !== record.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before steering this browser");
      if (!internal.vaultLoginFlow) assertE2BBrowserHandoffAllowsAction(action, (await getSession(userId)).browserHandoffs ?? [], record.lastUrl, record.sandboxId);
      if (!internal.vaultLoginFlow) await guardVaultBrowserAction(userId, record.sandboxId, { ...args, currentUrl: record.lastUrl }, internal.ownerPrivateRun, internal.ownerApprovedAction);
      const request: Record<string, unknown> = { action };
      if (action === "open") request.url = (await assertSafeBrowserUrl(args.url)).toString();
      if (action === "find") Object.assign(request, { role: args.role, name: args.name, nameMatch: args.nameMatch, limit: args.limit });
      if (action !== "open" && record.lastUrl) request.currentUrl = record.lastUrl;
      if (["state", "snapshot", "find", "open", "wait", "back", "forward", "refresh"].includes(action)) request.includePageContent = internal.ownerPrivateRun === true;
      if (["invoke", "fill", "focus", "click", "move", "hover", "select_option", "check", "uncheck", "type", "press", "upload", "upload_files"].includes(action) && args.nodeId) {
        const saved = record.nodes?.find((item) => item.nodeId === args.nodeId);
        if (!saved || Date.now() - saved.capturedAt > NODE_TTL_MS) throw new E2BBrowserError("E2B browser interaction requires a fresh find/state result");
        Object.assign(request, { selector: { role: saved.role, name: saved.name, index: saved.index }, ...(action === "fill" || action === "select_option" ? { value: args.value ?? args.text } : {}) });
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
      if (action === "drag") {
        const source = record.nodes?.find((item) => item.nodeId === args.startNodeId);
        const target = record.nodes?.find((item) => item.nodeId === args.endNodeId);
        if (!source || !target) throw new E2BBrowserError("E2B drag requires fresh startNodeId and endNodeId results");
        request.source = { role: source.role, name: source.name, index: source.index };
        request.target = { role: target.role, name: target.name, index: target.index };
      }
      if (action === "scroll") Object.assign(request, { direction: args.direction === "up" ? "up" : "down", amount: Math.max(1, Math.min(10, Number(args.amount ?? 3))) });
      if (action === "wait") request.timeoutMs = Math.max(50, Math.min(30_000, Number(args.timeoutSeconds ?? args.timeoutMs ?? 1_000) * (args.timeoutSeconds ? 1_000 : 1)));
      if (action === "tab_focus") request.index = Number(args.index ?? 0);
      if (action === "screenshot_region") Object.assign(request, { x: args.x, y: args.y, width: args.width, height: args.height });
      if (action === "screenshot_region_full") Object.assign(request, { x: args.x, y: args.y, width: args.width, height: args.height });
      if (action === "wait_download") request.timeoutMs = Math.max(100, Math.min(30_000, Number(args.timeoutSeconds ?? args.timeoutMs ?? 10_000) * (args.timeoutSeconds ? 1_000 : 1)));
      if (action === "recording_start") request.durationSeconds = Math.max(10, Math.min(900, Number(args.timeoutSeconds ?? 900)));
      if (action === "recording_stop" || action === "recording_get") request.recordingId = boundedText(args.recordingId ?? args.fileId, "recordingId", 128);
      let result = await this.run(sandbox, request);
      let importedFiles: E2BBrowserFileRecord[] = [];
      if (["wait_download"].includes(action)) importedFiles = await this.syncRuntimeFiles(userId, sandbox, record, "download");
      if (action === "recording_stop" && result.runtimeFilePath && result.recording?.id && result.recording.size) {
        const file = await this.persistRuntimeFile(userId, sandbox, record, { id: result.recording.id, kind: "recording", name: result.recording.name ?? `${result.recording.id}.mp4`, size: result.recording.size, createdAt: result.recording.createdAt ?? Date.now(), filePath: result.runtimeFilePath });
        importedFiles = [file];
        await this.run(sandbox, { action: "recording_ack", id: result.recording.id });
      }
      if (typeof result.url === "string" && /^https?:$/i.test(new URL(result.url).protocol)) await assertSafeBrowserUrl(result.url);
      const url = typeof result.url === "string" ? result.url : record.lastUrl ?? "";
      const nodes = normalizeMatches(result, url, Date.now());
      const next = await this.persistResult(userId, record, result, nodes);
      if (nodes.length) await rememberVaultBrowserNodes(userId, next.sandboxId, nodes, next.lastUrl);
      const safe = { provider: "e2b", sandboxId: next.sandboxId, action, ...(result.url ? { observedUrl: result.url, observationMethod: "playwright_page_url" } : {}), ...(result.title ? { title: redactBrowserText(result.title, 160) } : {}), ...(result.loadState ? { loadState: result.loadState } : {}), ...(nodes.length ? { matches: nodes } : {}), ...(internal.ownerPrivateRun === true && typeof result.pageContent === "string" ? { pageContent: normalizeE2BPageContent(result.pageContent).text, pageContentTruncated: result.pageContentTruncated === true } : {}), ...(result.download ? { download: result.download } : {}), ...(importedFiles.length ? { files: importedFiles.map((file) => ({ fileId: file.id, name: file.name, kind: file.kind, size: file.size, contentType: file.contentType, expiresAt: file.expiresAt })) } : {}), ...(result.recording ? { recording: { id: result.recording.id, name: result.recording.name, state: result.recording.state, size: result.recording.size, createdAt: result.recording.createdAt, ...(importedFiles[0] ? { fileId: importedFiles[0].id } : {}) } } : {}), ...(result.screenshot ? { __browserScreenshot: true, base64: result.screenshot, mediaType: "image/jpeg", sizeBytes: Math.floor(result.screenshot.length * 0.75) } : {}) };
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
      if (!record?.sandboxId || record.expiresAt <= Date.now()) throw new E2BBrowserError("No active E2B browser exists for secure checkout");
      if (record.sessionId && record.sessionId !== args.sessionId) throw new E2BBrowserError("Acquire the active E2B browser session lease before secure checkout");
      const node = record.nodes?.find((item) => item.nodeId === args.nodeId);
      if (!node || Date.now() - node.capturedAt > NODE_TTL_MS) throw new E2BBrowserError("Secure checkout requires a fresh accessible payment-field result");
      if (typeof args.value !== "string" || !args.value || args.value.length > 256) throw new E2BBrowserError("Secure checkout field value is invalid");
      const { sandbox } = await this.sandbox(userId, false);
      await guardVaultBrowserAction(userId, record.sandboxId, { action: "fill", currentUrl: record.lastUrl }, true, true);
      const result = await this.run(sandbox, { action: "fill", currentUrl: record.lastUrl, selector: { role: node.role, name: node.name, index: node.index }, value: args.value });
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
