import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore, getDaytonaWorkspace, getSession } from "../src/store.js";

let sandboxes: Map<string, any>;
let creates: number;
let lastCreateParams: Record<string, unknown> | undefined;

function fakeSandbox(id: string, state = "started") {
  const ptyOutputs = new Map<string, (data: Uint8Array) => void>();
  const sandbox: any = {
    id, name: `chusky-${id}`, state, recoverable: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    refreshData: async () => undefined,
    refreshActivity: async () => undefined,
    start: async () => { sandbox.state = "started"; },
    recover: async () => { sandbox.state = "started"; sandbox.recoverable = false; },
    pause: async () => { sandbox.state = "paused"; },
    stop: async () => { sandbox.state = "stopped"; },
    archive: async () => { sandbox.state = "archived"; },
    delete: async () => { sandbox.state = "destroyed"; sandboxes.delete(id); },
    process: {
      executeCommand: async (command: string) => { if (sandbox.commandError) throw sandbox.commandError; return { exitCode: sandbox.commandExitCode ?? 0, result: sandbox.commandResult ?? `ran:${command}` }; },
      createPty: async ({ id: ptyId, onData }: any) => { ptyOutputs.set(ptyId, onData); onData(new TextEncoder().encode("$ ")); return { sessionId: ptyId, isConnected: () => true, waitForConnection: async () => undefined, sendInput: async (input: string) => onData(new TextEncoder().encode(`ran:${input}`)), disconnect: async () => undefined }; },
      connectPty: async (ptyId: string, { onData }: any) => { ptyOutputs.set(ptyId, onData); return { sessionId: ptyId, isConnected: () => true, waitForConnection: async () => undefined, sendInput: async (input: string) => onData(new TextEncoder().encode(`ran:${input}`)), disconnect: async () => undefined }; },
      listPtySessions: async () => [...ptyOutputs.keys()].map((ptyId) => ({ id: ptyId, active: true })),
      resizePtySession: async () => undefined,
      killPtySession: async (ptyId: string) => { ptyOutputs.delete(ptyId); },
    },
    git: {
      clone: async () => undefined, status: async () => ({ currentBranch: "main", ahead: 0, behind: 0 }), branches: async () => ({ branches: ["main"] }),
      createBranch: async () => undefined, checkoutBranch: async () => undefined, pull: async () => undefined, add: async () => undefined,
      commit: async () => ({ sha: "abc123" }), push: async () => undefined,
    },
    fs: {
      listFiles: async () => [],
      downloadFile: async () => Buffer.from("persisted content"),
      uploadFile: async () => undefined,
      findFiles: async () => [],
      searchFiles: async () => ({ files: [] }),
      getFileDetails: async () => ({ name: "file.txt", path: "file.txt", size: 10 }),
      createFolder: async () => undefined,
      moveFiles: async () => undefined,
      deleteFile: async () => undefined,
    },
    getPreviewLink: async (port: number) => ({ url: sandbox.previewUrl ?? `https://preview.test/${port}` }),
    createSnapshot: async () => undefined,
    computerUse: {
      start: async () => undefined,
      getStatus: async () => ({ status: "running" }),
      display: { getInfo: async () => ({ displays: [{ width: 800, height: 600 }] }), getWindows: async () => ({ windows: [] }) },
      screenshot: { takeCompressed: async () => ({ screenshot: Buffer.from("image").toString("base64"), sizeBytes: 5 }) },
      mouse: { move: async (x: number, y: number) => ({ x, y }), click: async () => ({ x: 1, y: 2 }), drag: async () => ({ x: 3, y: 4 }), scroll: async () => true },
      keyboard: { type: async () => undefined, press: async () => undefined, hotkey: async () => undefined },
      accessibility: { getTree: async () => ({ root: {} }), findNodes: async () => ({ matches: [] }), focusNode: async () => undefined, invokeNode: async () => undefined, setNodeValue: async () => undefined },
    },
  };
  sandboxes.set(id, sandbox);
  return sandbox;
}

beforeEach(async () => {
  await initStore({ memoryOnly: true });
  sandboxes = new Map();
  creates = 0;
  lastCreateParams = undefined;
});

function engine() {
  return new DaytonaEngine(() => ({
    get: async (id: string) => {
      const sandbox = sandboxes.get(id);
      if (!sandbox) throw new Error("404 sandbox not found");
      return sandbox;
    },
    create: async (params: Record<string, unknown>) => { creates++; lastCreateParams = params; return fakeSandbox(`sandbox-${creates}`); },
  } as any));
}

test("creates one workspace and persists its provider ID", async () => {
  const e = engine();
  const first = await e.getOrCreateWorkspace(820001);
  const second = await e.getOrCreateWorkspace(820001);
  assert.equal(first.id, second.id);
  assert.equal(creates, 1);
  assert.equal((await getDaytonaWorkspace(820001))?.sandboxId, first.id);
  assert.equal(lastCreateParams?.autoPauseInterval, undefined);
});

test("reports an absent workspace without turning a normal status check into a tool failure", async () => {
  const result = await engine().workspace(820000, "status");
  assert.deepEqual(result, { exists: false, message: "No Daytona workspace exists yet. Use action=create, or use a file/computer tool and Chusky will create it automatically." });
});

test("reconnects after pause and refreshes activity", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820002);
  await e.pause(820002);
  assert.equal(sandbox.state, "paused");
  const result = await e.execute(820002, "pwd", "workspace");
  assert.equal(result.exitCode, 0);
  assert.equal(sandbox.state, "started");
  assert.equal(creates, 1);
});

test("turns Daytona execution timeouts into an actionable bounded result", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820015) as any;
  sandbox.commandError = { code: "PROCESS_EXECUTION_TIMEOUT", message: "command execution timeout" };
  const result = await e.execute(820015, "npm run build", "workspace", 3600);
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSeconds, 900);
  assert.match(result.output, /CHUCK_DAYTONA_PTY/);
});

test("recovers a recoverable sandbox instead of creating a replacement", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820003);
  sandbox.state = "error";
  sandbox.recoverable = true;
  const status = await e.workspace(820003, "status");
  assert.equal((status as any).state, "started");
  assert.equal(creates, 1);
});

test("clears a stale mapping and creates a fresh workspace", async () => {
  const e = engine();
  await e.getOrCreateWorkspace(820004);
  sandboxes.clear();
  const fresh = await e.getOrCreateWorkspace(820004);
  assert.equal(fresh.id, "sandbox-2");
  assert.equal((await getDaytonaWorkspace(820004))?.sandboxId, "sandbox-2");
});

test("deletes the provider sandbox and durable mapping only after confirmation path executes", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820005);
  const result = await e.deleteWorkspace(820005);
  assert.equal(result.deleted, true);
  assert.equal(sandbox.state, "destroyed");
  assert.equal(await getDaytonaWorkspace(820005), undefined);
});

test("computer-use actions start the desktop and return screenshots or structured state", async () => {
  const e = engine();
  const status = await e.computer(820006, { action: "status" });
  assert.deepEqual(status, { status: "running" });
  const screenshot = await e.computer(820006, { action: "screenshot" }) as any;
  assert.equal(screenshot.__daytonaScreenshot, true);
  assert.equal(screenshot.mediaType, "image/jpeg");
});

test("computer-use rejects invalid coordinates and oversized keyboard input", async () => {
  const e = engine();
  await assert.rejects(() => e.computer(820007, { action: "mouse_click", x: -1, y: 20 }), /coordinate/);
  await assert.rejects(() => e.computer(820007, { action: "keyboard_type", text: "x".repeat(4001) }), /1-4000/);
});

test("persists and reuses owned PTY sessions", async () => {
  const e = engine();
  const created = await e.pty(820008, { action: "create", id: "dev", cwd: "workspace" });
  assert.equal(created.sessionId, "dev");
  assert.equal((await getDaytonaWorkspace(820008))?.ptySessions?.[0]?.id, "dev");
  const output = await e.pty(820008, { action: "write", id: "dev", input: "npm test\n" });
  assert.match(output.output ?? "", /npm test/);
  await assert.rejects(() => e.pty(820008, { action: "write", id: "other", input: "x" }), /not found or not owned/);
  await e.pty(820008, { action: "kill", id: "dev" });
  assert.equal((await getDaytonaWorkspace(820008))?.ptySessions?.length, 0);
});

test("uses Daytona Git operations and returns bounded workflow results", async () => {
  const e = engine();
  const cloned = await e.git(820009, { action: "clone", repoUrl: "https://github.com/example/repo.git", path: "workspace/repo" });
  assert.equal(cloned.action, "clone");
  const committed = await e.git(820009, { action: "commit", path: "workspace/repo", message: "test", author: "Chusky", email: "chusky@example.com" });
  assert.deepEqual(committed.result, { sha: "abc123" });
  await assert.rejects(() => e.git(820009, { action: "clone", repoUrl: "https://evil.example/repo.git", path: "workspace/repo" }), /HTTPS GitHub/);
});

test("browser navigation persists safe URL state and rejects embedded credentials", async () => {
  const e = engine();
  const opened = await e.browser(820010, { action: "open", url: "https://example.com/docs" }) as any;
  assert.equal(opened.opened, "https://example.com/docs");
  assert.equal((await getDaytonaWorkspace(820010))?.browser?.lastUrl, "https://example.com/docs");
  await assert.rejects(() => e.browser(820010, { action: "open", url: "https://user:secret@example.com" }), /embedded credentials/);
});

test("returns a browser-accessible preview URL and rejects provider URL failures", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820014) as any;
  assert.deepEqual(await e.preview(820014, 3003), { sandboxId: sandbox.id, port: 3003, url: "https://preview.test/3003" });
  sandbox.previewUrl = "localhost:3003";
  await assert.rejects(() => e.preview(820014, 3003), /invalid preview URL/);
});

test("creates and persists a text artifact without placing bytes in session history", async () => {
  const e = engine();
  const result = await e.artifact(820011, { action: "create", type: "report", name: "findings.md", content: "# Findings\n\nVerified." }) as any;
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.name, "findings.md");
  const session = await (await import("../src/store.js")).getSession(820011);
  assert.equal(session.artifacts?.length, 1);
  assert.equal(session.history.length, 0);
  const listed = await e.artifact(820011, { action: "list" }) as any[];
  assert.equal(listed[0].id, result.id);
});

test("registers DOCX as a first-class artifact after Daytona structure validation", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820012) as any;
  const result = await e.artifact(820012, { action: "register", type: "docx", path: "workspace/artifacts/brief.docx" }) as any;
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.type, "docx");
  assert.equal(result.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("does not persist a structured artifact when Daytona validation fails", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820013) as any;
  sandbox.commandExitCode = 2;
  sandbox.commandResult = "invalid Office Open XML package";
  await assert.rejects(() => e.artifact(820013, { action: "register", type: "docx", path: "workspace/artifacts/broken.docx" }), /DOCX validation failed/);
  assert.equal((await getSession(820013)).artifacts?.length ?? 0, 0);
});
