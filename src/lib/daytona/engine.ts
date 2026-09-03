import { DaytonaProcessExecutionTimeoutError, type FileInfo, type Sandbox, type PtyHandle } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { clearDaytonaWorkspace, getDaytonaWorkspace, getSession, saveDaytonaWorkspace, saveSession, type ArtifactRecord, type ArtifactType } from "../../store.js";
import { DaytonaInputError } from "./errors.js";
import { getDaytonaClient } from "./client.js";
import type { DaytonaArtifactDelivery, DaytonaCommandResult, DaytonaFileInfo, DaytonaGitResult, DaytonaPreviewResult, DaytonaPtyResult, DaytonaScreenshotResult, DaytonaSnapshotResult, DaytonaWorkspaceInfo } from "./types.js";

const createPromises = new Map<number, Promise<Sandbox>>();
const configuredAutoPauseMinutes = Number.parseInt(config.daytonaAutoPauseInterval, 10);
// Daytona rejects autoPauseInterval for container sandboxes. Keep it disabled
// by default and let deployments opt in after choosing a pausable target.
const DAYTONA_AUTO_PAUSE_MINUTES = Number.isInteger(configuredAutoPauseMinutes) && configuredAutoPauseMinutes > 0
  ? configuredAutoPauseMinutes
  : 0;
const DAYTONA_MAX_COMMAND_LENGTH = 8000;
const DAYTONA_MAX_OUTPUT_CHARS = 12000;
const DAYTONA_MAX_FILE_CONTENT = 48000;
const DAYTONA_MAX_PTY_OUTPUT = 12000;
const DAYTONA_MAX_ARTIFACT_BYTES = 45 * 1024 * 1024;
const DAYTONA_MAX_EXECUTION_SECONDS = 900;

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function safeDaytonaPath(value: unknown, label = "path"): string {
  const path = String(value ?? "").trim();
  if (!path || path.includes("\0") || path.split(/[\\/]+/).includes("..")) {
    throw new DaytonaInputError(`${label} must be a non-empty workspace-relative path without '..'`);
  }
  return path;
}

function workspaceInfo(sandbox: Sandbox): DaytonaWorkspaceInfo {
  return {
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    sandboxClass: sandbox.sandboxClass,
    cpu: sandbox.cpu,
    memory: sandbox.memory,
    disk: sandbox.disk,
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
    autoPauseInterval: sandbox.autoPauseInterval,
    networkBlockAll: sandbox.networkBlockAll,
    domainAllowList: sandbox.domainAllowList,
  };
}

function workspaceRecord(sandbox: Sandbox) {
  return {
    sandboxId: sandbox.id,
    name: sandbox.name,
    createdAt: Date.parse(sandbox.createdAt ?? "") || Date.now(),
    updatedAt: Date.now(),
    lastKnownState: sandbox.state,
  };
}

function coordinate(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new DaytonaInputError(`${label} must be a coordinate between 0 and 10000`);
  return Math.floor(n);
}

function boundedText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "");
  if (!text || text.length > max) throw new DaytonaInputError(`${label} must be 1-${max} characters`);
  return text;
}

const ARTIFACT_TYPES = new Set<ArtifactType>(["website", "report", "docx", "presentation", "pdf", "spreadsheet", "image", "video", "zip", "project"]);
const ARTIFACT_MIME: Record<ArtifactType, string> = {
  website: "text/html", report: "text/markdown", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf", spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", image: "image/png",
  video: "video/mp4", zip: "application/zip", project: "application/zip",
};

const STRUCTURED_ARTIFACT_TYPES = new Set<ArtifactType>(["docx", "presentation", "pdf", "spreadsheet"]);

function artifactValidationScript(type: ArtifactType, path: string): string {
  const officeRoots: Partial<Record<ArtifactType, string>> = {
    docx: "word/document.xml",
    presentation: "ppt/presentation.xml",
    spreadsheet: "xl/workbook.xml",
  };
  const root = officeRoots[type];
  return [
    "import os, sys, zipfile, xml.etree.ElementTree as ET",
    `path=${JSON.stringify(path)}`,
    `kind=${JSON.stringify(type)}`,
    "def fail(message):",
    "    print(message, file=sys.stderr)",
    "    raise SystemExit(2)",
    "if not os.path.isfile(path): fail('artifact file does not exist')",
    "if kind == 'pdf':",
    "    with open(path, 'rb') as f:",
    "        header = f.read(5)",
    "        f.seek(max(0, os.path.getsize(path) - 4096))",
    "        tail = f.read()",
    "    if header != b'%PDF-': fail('invalid PDF header')",
    "    if b'%%EOF' not in tail: fail('PDF is missing an EOF marker')",
    "else:",
    "    try:",
    "        with zipfile.ZipFile(path) as archive:",
    "            bad = archive.testzip()",
    "            names = set(archive.namelist())",
    "    except (OSError, zipfile.BadZipFile) as error:",
    "        fail('invalid Office Open XML package: ' + str(error))",
    "    if bad: fail('Office Open XML package has a corrupt member: ' + bad)",
    `    required = ['[Content_Types].xml', ${JSON.stringify(root ?? "")} ]`,
    "    missing = [name for name in required if name and name not in names]",
    "    if missing: fail('Office Open XML package is missing: ' + ', '.join(missing))",
    "    try:",
    "        with zipfile.ZipFile(path) as archive:",
    "            for name in required:",
    "                if name: ET.fromstring(archive.read(name))",
    "    except (KeyError, ET.ParseError, OSError) as error:",
    "        fail('Office Open XML package contains invalid XML: ' + str(error))",
    "print('artifact structure validated')",
  ].join("\n");
}

function artifactType(value: unknown): ArtifactType {
  const type = String(value ?? "").trim() as ArtifactType;
  if (!ARTIFACT_TYPES.has(type)) throw new DaytonaInputError("type must be a supported artifact type");
  return type;
}

function artifactName(value: unknown): string {
  const name = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!name || name.length > 120) throw new DaytonaInputError("name must be 1-120 safe characters");
  return name;
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function collectPtyOutput(): { chunks: string[]; onData: (data: Uint8Array) => void } {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  return { chunks, onData: (data) => { chunks.push(decoder.decode(data, { stream: true })); } };
}

async function brieflyCollect(handle: PtyHandle, milliseconds = 250): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  if (!handle.isConnected()) return;
}

export class DaytonaEngine {
  constructor(private readonly clientFactory: typeof getDaytonaClient = getDaytonaClient) {}

  private async getSandbox(userId: number): Promise<Sandbox | undefined> {
    const stored = await getDaytonaWorkspace(userId);
    if (!stored?.sandboxId) return undefined;
    try {
      const sandbox = await this.clientFactory().get(stored.sandboxId);
      await sandbox.refreshData();
      if (sandbox.recoverable && sandbox.state !== "started") await sandbox.recover(60);
      else if (sandbox.state !== "started") await sandbox.start(60);
      await sandbox.refreshActivity();
      await saveDaytonaWorkspace(userId, { ...stored, name: sandbox.name, updatedAt: Date.now(), lastKnownState: sandbox.state });
      return sandbox;
    } catch (error) {
      const message = String(error);
      if (/not found|404|destroyed/i.test(message)) {
        await clearDaytonaWorkspace(userId);
        return undefined;
      }
      throw error;
    }
  }

  async getOrCreateWorkspace(userId: number): Promise<Sandbox> {
    const existing = await this.getSandbox(userId);
    if (existing) return existing;

    const pending = createPromises.get(userId);
    if (pending) return pending;

    const creation = (async () => {
      const client = this.clientFactory();
      const createParams = {
        ...(config.daytonaSnapshot ? { snapshot: config.daytonaSnapshot } : {}),
        name: `chusky-${userId}`,
        language: "typescript",
        ...(config.daytonaDomainAllowList ? { domainAllowList: config.daytonaDomainAllowList } : { networkBlockAll: config.daytonaNetworkBlockAll }),
        labels: { agent: "chusky", user_id: String(userId) },
        ...(DAYTONA_AUTO_PAUSE_MINUTES > 0 ? { autoPauseInterval: DAYTONA_AUTO_PAUSE_MINUTES } : {}),
      };
      const sandbox = await client.create(createParams, { timeout: 120 });
      await saveDaytonaWorkspace(userId, workspaceRecord(sandbox));
      return sandbox;
    })();
    createPromises.set(userId, creation);
    try {
      return await creation;
    } finally {
      createPromises.delete(userId);
    }
  }

  async workspace(userId: number, action: "get" | "create" | "status" | "pause" | "archive" | "delete"): Promise<DaytonaWorkspaceInfo | { exists: false; message: string } | { paused: boolean; sandboxId: string } | { deleted: boolean; sandboxId: string }> {
    if (action === "delete") return this.deleteWorkspace(userId);
    if (action === "pause") return this.pause(userId);
    if (action === "create") return workspaceInfo(await this.getOrCreateWorkspace(userId));
    const sandbox = await this.getSandbox(userId);
    if (!sandbox) {
      return { exists: false, message: "No Daytona workspace exists yet. Use action=create, or use a file/computer tool and Chusky will create it automatically." };
    }
    if (action === "status") await sandbox.refreshData();
    if (action === "archive") {
      await sandbox.stop(60);
      await sandbox.archive();
      await saveDaytonaWorkspace(userId, { ...(await getDaytonaWorkspace(userId))!, updatedAt: Date.now(), lastKnownState: "archived" });
    }
    return workspaceInfo(sandbox);
  }

  async execute(userId: number, command: string, cwd?: string, timeoutSeconds?: number): Promise<DaytonaCommandResult> {
    const normalized = String(command ?? "").trim();
    if (!normalized || normalized.length > DAYTONA_MAX_COMMAND_LENGTH) {
      throw new DaytonaInputError(`command must be 1-${DAYTONA_MAX_COMMAND_LENGTH} characters`);
    }
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedCwd = cwd ? safeDaytonaPath(cwd, "cwd") : undefined;
    const normalizedTimeout = boundedInt(timeoutSeconds, 60, DAYTONA_MAX_EXECUTION_SECONDS);
    let result: { exitCode?: number; result?: string; artifacts?: { stdout?: string } };
    try {
      result = await sandbox.process.executeCommand(normalized, normalizedCwd, undefined, normalizedTimeout);
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? "");
      if (error instanceof DaytonaProcessExecutionTimeoutError || code === "PROCESS_EXECUTION_TIMEOUT") {
        return {
          sandboxId: sandbox.id,
          command: normalized,
          cwd: normalizedCwd,
          exitCode: 124,
          output: `Command exceeded the ${normalizedTimeout}-second execution limit. Use CHUCK_DAYTONA_PTY for long-running processes, or split the work into smaller verified commands.`,
          truncated: false,
          timedOut: true,
          timeoutSeconds: normalizedTimeout,
        };
      }
      throw error;
    }
    const raw = String(result.result ?? result.artifacts?.stdout ?? "");
    const output = raw.slice(0, DAYTONA_MAX_OUTPUT_CHARS);
    return { sandboxId: sandbox.id, command: normalized, cwd: normalizedCwd, exitCode: result.exitCode ?? 1, output, truncated: raw.length > output.length, timeoutSeconds: normalizedTimeout };
  }

  async listFiles(userId: number, path?: string, depth?: number): Promise<DaytonaFileInfo[]> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const files = await sandbox.fs.listFiles(path ? safeDaytonaPath(path) : ".", { depth: boundedInt(depth, 1, 5) });
    return (files as FileInfo[]).map((file) => ({
      name: file.name,
      path: file.path ?? file.name,
      size: file.size,
      isDir: file.isDir,
      modifiedAt: file.modifiedAt,
    }));
  }

  async readFile(userId: number, path: string, maxChars?: number): Promise<{ path: string; content: string; truncated: boolean }> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const bytes = await sandbox.fs.downloadFile(safeDaytonaPath(path));
    const limit = boundedInt(maxChars, DAYTONA_MAX_OUTPUT_CHARS, DAYTONA_MAX_OUTPUT_CHARS);
    const content = bytes.toString("utf8");
    return { path, content: content.slice(0, limit), truncated: content.length > limit };
  }

  async writeFile(userId: number, path: string, content: string): Promise<{ path: string; bytes: number }> {
    const normalizedPath = safeDaytonaPath(path);
    const normalizedContent = String(content ?? "");
    if (normalizedContent.length > DAYTONA_MAX_FILE_CONTENT) throw new DaytonaInputError(`content must be at most ${DAYTONA_MAX_FILE_CONTENT} characters`);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.uploadFile(Buffer.from(normalizedContent, "utf8"), normalizedPath);
    return { path: normalizedPath, bytes: Buffer.byteLength(normalizedContent, "utf8") };
  }

  async findFiles(userId: number, path: string | undefined, pattern: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedPattern = String(pattern ?? "").trim();
    if (!normalizedPattern || normalizedPattern.length > 200) throw new DaytonaInputError("pattern must be 1-200 characters");
    return sandbox.fs.findFiles(path ? safeDaytonaPath(path) : ".", normalizedPattern);
  }

  async searchFiles(userId: number, path: string | undefined, pattern: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    const normalizedPattern = String(pattern ?? "").trim();
    if (!normalizedPattern || normalizedPattern.length > 200) throw new DaytonaInputError("pattern must be 1-200 characters");
    return sandbox.fs.searchFiles(path ? safeDaytonaPath(path) : ".", normalizedPattern);
  }

  async fileDetails(userId: number, path: string): Promise<unknown> {
    const sandbox = await this.getOrCreateWorkspace(userId);
    return sandbox.fs.getFileDetails(safeDaytonaPath(path));
  }

  async createFolder(userId: number, path: string): Promise<{ path: string; created: boolean }> {
    const normalizedPath = safeDaytonaPath(path);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.createFolder(normalizedPath, "755");
    return { path: normalizedPath, created: true };
  }

  async moveFiles(userId: number, source: string, destination: string): Promise<{ source: string; destination: string; moved: boolean }> {
    const normalizedSource = safeDaytonaPath(source, "source");
    const normalizedDestination = safeDaytonaPath(destination, "destination");
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.moveFiles(normalizedSource, normalizedDestination);
    return { source: normalizedSource, destination: normalizedDestination, moved: true };
  }

  async deleteFile(userId: number, path: string, recursive = false): Promise<{ path: string; deleted: boolean }> {
    const normalizedPath = safeDaytonaPath(path);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.fs.deleteFile(normalizedPath, recursive);
    return { path: normalizedPath, deleted: true };
  }

  async preview(userId: number, port: number): Promise<DaytonaPreviewResult> {
    const normalizedPort = boundedInt(port, 3000, 65535);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const result = await sandbox.getPreviewLink(normalizedPort);
    const url = String(result.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new DaytonaInputError("Daytona returned an invalid preview URL");
    return { sandboxId: sandbox.id, port: normalizedPort, url };
  }

  async createSnapshot(userId: number, name: string): Promise<DaytonaSnapshotResult> {
    const normalizedName = String(name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,80}$/.test(normalizedName)) throw new DaytonaInputError("snapshot name must be 2-81 safe characters");
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.createSnapshot(normalizedName, 120);
    return { sandboxId: sandbox.id, name: normalizedName, created: true };
  }

  async computer(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 40);
    const sandbox = await this.getOrCreateWorkspace(userId);
    await sandbox.computerUse.start();
    const computer = sandbox.computerUse;
    switch (action) {
      case "status": return computer.getStatus();
      case "display": return computer.display.getInfo();
      case "windows": return computer.display.getWindows();
      case "screenshot": {
        const result = await computer.screenshot.takeCompressed({ format: "jpeg", quality: 70, scale: 0.75, showCursor: args.showCursor === true });
        if (!result.screenshot) throw new DaytonaInputError("Daytona returned an empty screenshot");
        return { __daytonaScreenshot: true, sandboxId: sandbox.id, mediaType: "image/jpeg", base64: result.screenshot, sizeBytes: result.sizeBytes } satisfies DaytonaScreenshotResult & { __daytonaScreenshot: true };
      }
      case "mouse_move": return computer.mouse.move(coordinate(args.x, "x"), coordinate(args.y, "y"));
      case "mouse_click": return computer.mouse.click(coordinate(args.x, "x"), coordinate(args.y, "y"), args.button ? boundedText(args.button, "button", 10) : "left", args.double === true);
      case "mouse_drag": return computer.mouse.drag(coordinate(args.startX, "startX"), coordinate(args.startY, "startY"), coordinate(args.endX, "endX"), coordinate(args.endY, "endY"), args.button ? boundedText(args.button, "button", 10) : "left");
      case "mouse_scroll": return computer.mouse.scroll(coordinate(args.x, "x"), coordinate(args.y, "y"), args.direction === "up" ? "up" : "down", Math.min(Math.max(Math.floor(Number(args.amount ?? 1)), 1), 20));
      case "keyboard_type": await computer.keyboard.type(boundedText(args.text, "text", 4000), Math.min(Math.max(Math.floor(Number(args.delayMs ?? 0)), 0), 1000)); return { typed: true };
      case "keyboard_press": await computer.keyboard.press(boundedText(args.key, "key", 40), Array.isArray(args.modifiers) ? args.modifiers.map((m) => boundedText(m, "modifier", 20)) : []); return { pressed: true };
      case "keyboard_hotkey": await computer.keyboard.hotkey(boundedText(args.keys, "keys", 100)); return { pressed: true };
      case "accessibility_tree": return computer.accessibility.getTree({ scope: args.scope ? boundedText(args.scope, "scope", 20) : "all", maxDepth: Math.min(Math.max(Math.floor(Number(args.maxDepth ?? 4)), 0), 8) });
      case "accessibility_find": return computer.accessibility.findNodes({ scope: "all", role: args.role ? boundedText(args.role, "role", 60) : undefined, name: args.name ? boundedText(args.name, "name", 200) : undefined, nameMatch: args.nameMatch ? boundedText(args.nameMatch, "nameMatch", 30) : undefined, limit: Math.min(Math.max(Math.floor(Number(args.limit ?? 20)), 1), 50) });
      case "accessibility_focus": await computer.accessibility.focusNode(boundedText(args.nodeId, "nodeId", 200)); return { focused: true };
      case "accessibility_invoke": await computer.accessibility.invokeNode(boundedText(args.nodeId, "nodeId", 200), args.nodeAction ? boundedText(args.nodeAction, "nodeAction", 80) : undefined); return { invoked: true };
      case "accessibility_set_value": await computer.accessibility.setNodeValue(boundedText(args.nodeId, "nodeId", 200), boundedText(args.value, "value", 4000)); return { updated: true };
      default: throw new DaytonaInputError(`Unsupported computer action: ${action}`);
    }
  }

  async pty(userId: number, args: Record<string, unknown>): Promise<DaytonaPtyResult> {
    const action = boundedText(args.action, "action", 20);
    const stored = await getDaytonaWorkspace(userId);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const known = new Set((stored?.ptySessions ?? []).map((session) => session.id));
    const requestedId = args.id ? boundedText(args.id, "id", 120) : undefined;
    const ensureOwned = () => {
      if (!requestedId || !known.has(requestedId)) throw new DaytonaInputError("PTY session not found or not owned by you");
      return requestedId;
    };
    const saveSessions = async (sessions: Array<{ id: string; createdAt: number }>) => {
      const current = await getDaytonaWorkspace(userId);
      if (current) await saveDaytonaWorkspace(userId, { ...current, ptySessions: sessions, updatedAt: Date.now() });
    };

    if (action === "status") {
      const sessions = await sandbox.process.listPtySessions();
      return { sandboxId: sandbox.id, sessionId: "", sessions: sessions.filter((session) => known.has(session.id)) };
    }
    if (action === "create") {
      const id = requestedId ?? `chusky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (known.has(id)) throw new DaytonaInputError("A PTY session with that id already exists");
      const output = collectPtyOutput();
      const handle = await sandbox.process.createPty({ id, cwd: args.cwd ? safeDaytonaPath(args.cwd, "cwd") : undefined, cols: boundedNumber(args.cols, 120, 300), rows: boundedNumber(args.rows, 30, 200), onData: output.onData });
      await handle.waitForConnection();
      await brieflyCollect(handle);
      await handle.disconnect();
      await saveSessions([...((await getDaytonaWorkspace(userId))?.ptySessions ?? []), { id, createdAt: Date.now() }]);
      return { sandboxId: sandbox.id, sessionId: id, output: output.chunks.join("").slice(-DAYTONA_MAX_PTY_OUTPUT), created: true };
    }
    const id = ensureOwned();
    if (action === "resize") {
      await sandbox.process.resizePtySession(id, boundedNumber(args.cols, 120, 300), boundedNumber(args.rows, 30, 200));
      return { sandboxId: sandbox.id, sessionId: id };
    }
    if (action === "kill") {
      await sandbox.process.killPtySession(id);
      await saveSessions((await getDaytonaWorkspace(userId))?.ptySessions?.filter((session) => session.id !== id) ?? []);
      return { sandboxId: sandbox.id, sessionId: id, killed: true };
    }
    if (action !== "read" && action !== "write") throw new DaytonaInputError(`Unsupported PTY action: ${action}`);
    const output = collectPtyOutput();
    const handle = await sandbox.process.connectPty(id, { onData: output.onData });
    try {
      await handle.waitForConnection();
      if (action === "write") await handle.sendInput(boundedText(args.input, "input", 8000));
      await brieflyCollect(handle, action === "write" ? 400 : 250);
    } finally {
      await handle.disconnect();
    }
    return { sandboxId: sandbox.id, sessionId: id, output: output.chunks.join("").slice(-DAYTONA_MAX_PTY_OUTPUT) };
  }

  async git(userId: number, args: Record<string, unknown>): Promise<DaytonaGitResult> {
    const action = boundedText(args.action, "action", 30);
    const sandbox = await this.getOrCreateWorkspace(userId);
    const path = safeDaytonaPath(args.path ?? "workspace/repo", "path");
    const git = sandbox.git;
    let result: unknown;
    switch (action) {
      case "clone": {
        const url = boundedText(args.repoUrl, "repoUrl", 500);
        if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/)?$/i.test(url)) throw new DaytonaInputError("repoUrl must be an HTTPS GitHub repository URL without embedded credentials");
        await git.clone(url, path, args.branch ? boundedText(args.branch, "branch", 200) : undefined, undefined, undefined, undefined, false, 50);
        result = { cloned: true, url };
        break;
      }
      case "status": result = await git.status(path); break;
      case "branches": result = await git.branches(path); break;
      case "create_branch": await git.createBranch(path, boundedText(args.branch, "branch", 200)); result = { created: true }; break;
      case "checkout": await git.checkoutBranch(path, boundedText(args.branch, "branch", 200)); result = { checkedOut: true }; break;
      case "pull": await git.pull(path, undefined, undefined, args.branch ? boundedText(args.branch, "branch", 200) : undefined, args.remote ? boundedText(args.remote, "remote", 100) : undefined); result = { pulled: true }; break;
      case "add": {
        const files = Array.isArray(args.files) && args.files.length ? args.files.map((file) => safeDaytonaPath(file, "file")) : ["."];
        await git.add(path, files); result = { staged: files };
        break;
      }
      case "commit": result = await git.commit(path, boundedText(args.message, "message", 500), boundedText(args.author ?? "Chusky", "author", 120), boundedText(args.email ?? "chusky@localhost", "email", 200)); break;
      case "push": await git.push(path, undefined, undefined, args.branch ? boundedText(args.branch, "branch", 200) : undefined, args.remote ? boundedText(args.remote, "remote", 100) : undefined, true); result = { pushed: true }; break;
      default: throw new DaytonaInputError(`Unsupported Git action: ${action}`);
    }
    return { sandboxId: sandbox.id, path, action, result };
  }

  async browser(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 20);
    const sandbox = await this.getOrCreateWorkspace(userId);
    if (action === "status") {
      const stored = await getDaytonaWorkspace(userId);
      return { sandboxId: sandbox.id, lastUrl: stored?.browser?.lastUrl, computer: await this.computer(userId, { action: "status" }), windows: await this.computer(userId, { action: "windows" }) };
    }
    if (action === "open") {
      const url = boundedText(args.url, "url", 2000);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new DaytonaInputError("Browser URL must be a valid http(s) URL"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DaytonaInputError("Browser URL must use http:// or https://");
      if (parsed.username || parsed.password) throw new DaytonaInputError("Browser URLs cannot contain embedded credentials");
      await this.computer(userId, { action: "keyboard_hotkey", keys: "CTRL+L" });
      await this.computer(userId, { action: "keyboard_type", text: url });
      await this.computer(userId, { action: "keyboard_press", key: "ENTER" });
      const current = await getDaytonaWorkspace(userId);
      if (current) await saveDaytonaWorkspace(userId, { ...current, browser: { lastUrl: parsed.toString(), updatedAt: Date.now() }, updatedAt: Date.now() });
      return { sandboxId: sandbox.id, opened: url };
    }
    if (action === "snapshot") {
      return { sandboxId: sandbox.id, accessibility: await this.computer(userId, { action: "accessibility_tree", scope: "focused", maxDepth: boundedNumber(args.maxDepth, 6, 10) }) };
    }
    if (action === "find") {
      return { sandboxId: sandbox.id, matches: await this.computer(userId, { action: "accessibility_find", role: args.role, name: args.name, nameMatch: args.nameMatch, limit: boundedNumber(args.limit, 20, 50) }) };
    }
    if (action === "focus") return this.computer(userId, { action: "accessibility_focus", nodeId: args.nodeId });
    if (action === "invoke") return this.computer(userId, { action: "accessibility_invoke", nodeId: args.nodeId, nodeAction: args.nodeAction });
    if (action === "fill") return this.computer(userId, { action: "accessibility_set_value", nodeId: args.nodeId, value: args.value ?? args.text });
    if (action === "windows") return this.computer(userId, { action: "windows" });
    if (action === "screenshot") return this.computer(userId, { action: "screenshot", showCursor: false });
    if (action === "click") return this.computer(userId, { action: "mouse_click", x: args.x, y: args.y, button: "left" });
    if (action === "type") return this.computer(userId, { action: "keyboard_type", text: args.text, delayMs: 0 });
    if (action === "press") return this.computer(userId, { action: "keyboard_press", key: args.key, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [] });
    if (action === "scroll") return this.computer(userId, { action: "mouse_scroll", x: args.x ?? 500, y: args.y ?? 400, direction: args.direction, amount: args.amount ?? 3 });
    if (action === "back" || action === "forward" || action === "refresh") {
      const key = action === "back" ? "ALT+LEFT" : action === "forward" ? "ALT+RIGHT" : "CTRL+R";
      return this.computer(userId, { action: "keyboard_hotkey", keys: key });
    }
    throw new DaytonaInputError(`Unsupported browser action: ${action}`);
  }

  private async saveArtifact(userId: number, artifact: ArtifactRecord): Promise<void> {
    const session = await getSession(userId);
    session.artifacts = [...(session.artifacts ?? []).filter((item) => item.id !== artifact.id), artifact].slice(-100);
    await saveSession(userId, session);
  }

  private async validateArtifactStructure(sandbox: Sandbox, path: string, type: ArtifactType): Promise<void> {
    if (!STRUCTURED_ARTIFACT_TYPES.has(type)) return;
    const script = artifactValidationScript(type, path);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, undefined, undefined, 120);
    if (result.exitCode !== 0) {
      throw new DaytonaInputError(`${type.toUpperCase()} validation failed: ${String(result.result ?? "unknown validation error").slice(0, 500)}`);
    }
  }

  async artifact(userId: number, args: Record<string, unknown>): Promise<unknown> {
    const action = boundedText(args.action, "action", 20);
    const session = await getSession(userId);
    const artifacts = session.artifacts ?? [];
    if (action === "list") return artifacts.slice(-100).reverse();
    if (action === "get" || action === "delete") {
      const id = boundedText(args.id, "id", 120);
      const existing = artifacts.find((item) => item.id === id);
      if (!existing) throw new DaytonaInputError("Artifact not found or not owned by you");
      if (action === "get") return existing;
      if (args.removeFile === true) {
        const sandbox = await this.getOrCreateWorkspace(userId);
        await sandbox.fs.deleteFile(existing.path, false);
      }
      session.artifacts = artifacts.filter((item) => item.id !== id);
      await saveSession(userId, session);
      return { id, deleted: true, fileRemoved: args.removeFile === true };
    }
    const sandbox = await this.getOrCreateWorkspace(userId);
    if (action === "package") {
      const files = Array.isArray(args.files) ? args.files.map((file) => safeDaytonaPath(file, "file")) : [];
      if (!files.length || files.length > 100) throw new DaytonaInputError("files must contain 1-100 workspace-relative paths");
      const name = artifactName(args.name ?? "chusky-project.zip");
      const path = safeDaytonaPath(`artifacts/${name}`, "output path");
      const script = `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(path)},'w',zipfile.ZIP_DEFLATED)\n[z.write(p) for p in ${JSON.stringify(files)}]\nz.close()`;
      const encoded = Buffer.from(script, "utf8").toString("base64");
      const result = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, undefined, undefined, 120);
      if (result.exitCode !== 0) throw new DaytonaInputError(`ZIP creation failed: ${String(result.result ?? "unknown error").slice(0, 500)}`);
      return this.registerArtifact(userId, sandbox, path, name, "zip", "application/zip");
    }
    const type = artifactType(args.type);
    if (action === "create") {
      if (args.path) return this.registerArtifact(userId, sandbox, safeDaytonaPath(args.path, "path"), artifactName(args.name), type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
      if (typeof args.content !== "string") throw new DaytonaInputError("create requires content for text artifacts or path for generated binary artifacts");
      if (!["website", "report"].includes(type)) throw new DaytonaInputError("Binary artifacts must be generated in Daytona and passed by path; only website and report accept text content directly");
      if (args.content.length > DAYTONA_MAX_FILE_CONTENT) throw new DaytonaInputError(`content must be at most ${DAYTONA_MAX_FILE_CONTENT} characters`);
      const name = artifactName(args.name ?? (type === "website" ? "website.html" : "report.md"));
      const path = safeDaytonaPath(`artifacts/${name}`, "output path");
      await sandbox.fs.uploadFile(Buffer.from(args.content, "utf8"), path);
      return this.registerArtifact(userId, sandbox, path, name, type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
    }
    if (action === "register") {
      const path = safeDaytonaPath(args.path, "path");
      return this.registerArtifact(userId, sandbox, path, artifactName(args.name ?? String(path).split(/[\\/]/).pop()), type, args.contentType ? boundedText(args.contentType, "contentType", 120) : ARTIFACT_MIME[type]);
    }
    throw new DaytonaInputError(`Unsupported artifact action: ${action}`);
  }

  private async registerArtifact(userId: number, sandbox: Sandbox, path: string, name: string, type: ArtifactType, contentType: string): Promise<ArtifactRecord & { __chuskyArtifactReady: true }> {
    const details = await sandbox.fs.getFileDetails(path) as { size?: number; isDir?: boolean };
    const size = Number(details.size ?? 0);
    if (details.isDir) throw new DaytonaInputError("Artifact path must be a file, not a directory");
    if (!Number.isFinite(size) || size < 1 || size > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError(`Artifact must be between 1 byte and ${DAYTONA_MAX_ARTIFACT_BYTES} bytes`);
    await this.validateArtifactStructure(sandbox, path, type);
    const now = Date.now();
    const artifact: ArtifactRecord = { id: `artifact_${randomUUID()}`, userId, sandboxId: sandbox.id, name, type, path, contentType, size, status: "available", createdAt: now, updatedAt: now };
    await this.saveArtifact(userId, artifact);
    return { ...artifact, __chuskyArtifactReady: true };
  }

  async downloadArtifact(userId: number, id: string): Promise<DaytonaArtifactDelivery> {
    const artifact = (await getSession(userId)).artifacts?.find((item) => item.id === id);
    if (!artifact) throw new DaytonaInputError("Artifact not found or not owned by you");
    const bytes = await (await this.getOrCreateWorkspace(userId)).fs.downloadFile(artifact.path);
    if (bytes.length > DAYTONA_MAX_ARTIFACT_BYTES) throw new DaytonaInputError("Artifact is too large to deliver through Telegram");
    return { id: artifact.id, name: artifact.name, type: artifact.type, path: artifact.path, contentType: artifact.contentType, size: bytes.length, data: bytes };
  }

  async deleteWorkspace(userId: number): Promise<{ sandboxId: string; deleted: boolean }> {
    const stored = await getDaytonaWorkspace(userId);
    if (!stored) throw new DaytonaInputError("No Daytona workspace exists.");
    const sandbox = await this.clientFactory().get(stored.sandboxId);
    await sandbox.delete(60, true);
    await clearDaytonaWorkspace(userId);
    return { sandboxId: stored.sandboxId, deleted: true };
  }

  async pause(userId: number): Promise<{ paused: boolean; sandboxId: string }> {
    const sandbox = await this.getSandbox(userId);
    if (!sandbox) throw new DaytonaInputError("No Daytona workspace exists.");
    await sandbox.pause(60);
    return { paused: true, sandboxId: sandbox.id };
  }
}

export const daytonaEngine = new DaytonaEngine();
