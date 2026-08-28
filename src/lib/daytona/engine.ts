import { type FileInfo, type Sandbox } from "@daytona/sdk";
import { config } from "../../config.js";
import { clearDaytonaWorkspace, getDaytonaWorkspace, saveDaytonaWorkspace } from "../../store.js";
import { DaytonaInputError } from "./errors.js";
import { getDaytonaClient } from "./client.js";
import type { DaytonaCommandResult, DaytonaFileInfo, DaytonaPreviewResult, DaytonaScreenshotResult, DaytonaSnapshotResult, DaytonaWorkspaceInfo } from "./types.js";

const createPromises = new Map<number, Promise<Sandbox>>();
const DAYTONA_AUTO_PAUSE_MINUTES = 60;
const DAYTONA_MAX_COMMAND_LENGTH = 8000;
const DAYTONA_MAX_OUTPUT_CHARS = 12000;
const DAYTONA_MAX_FILE_CONTENT = 48000;

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
      const sandbox = await client.create({
        ...(config.daytonaSnapshot ? { snapshot: config.daytonaSnapshot } : {}),
        name: `chusky-${userId}`,
        language: "typescript",
        autoPauseInterval: DAYTONA_AUTO_PAUSE_MINUTES,
        networkBlockAll: true,
        labels: { agent: "chusky", user_id: String(userId) },
      }, { timeout: 120 });
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

  async workspace(userId: number, action: "get" | "create" | "status" | "pause" | "archive" | "delete"): Promise<DaytonaWorkspaceInfo | { paused: boolean; sandboxId: string } | { deleted: boolean; sandboxId: string }> {
    if (action === "delete") return this.deleteWorkspace(userId);
    if (action === "pause") return this.pause(userId);
    if (action === "create") return workspaceInfo(await this.getOrCreateWorkspace(userId));
    const sandbox = await this.getSandbox(userId);
    if (!sandbox) throw new DaytonaInputError("No Daytona workspace exists yet. Use action=create first.");
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
    const result = await sandbox.process.executeCommand(
      normalized,
      cwd ? safeDaytonaPath(cwd, "cwd") : undefined,
      undefined,
      boundedInt(timeoutSeconds, 60, 900),
    );
    const raw = String(result.result ?? result.artifacts?.stdout ?? "");
    const output = raw.slice(0, DAYTONA_MAX_OUTPUT_CHARS);
    return { sandboxId: sandbox.id, command: normalized, cwd, exitCode: result.exitCode, output, truncated: raw.length > output.length };
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
    return { sandboxId: sandbox.id, port: normalizedPort, url: result.url };
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
