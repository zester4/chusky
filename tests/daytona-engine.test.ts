import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore, getDaytonaWorkspace } from "../src/store.js";

let sandboxes: Map<string, any>;
let creates: number;
let lastCreateParams: Record<string, unknown> | undefined;

function fakeSandbox(id: string, state = "started") {
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
    process: { executeCommand: async (command: string) => ({ exitCode: 0, result: `ran:${command}` }) },
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
    getPreviewLink: async (port: number) => ({ url: `https://preview.test/${port}` }),
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
