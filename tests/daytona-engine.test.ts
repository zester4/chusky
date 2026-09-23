import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { appScaffoldCommand, DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore, getDaytonaWorkspace, getSession } from "../src/store.js";

let sandboxes: Map<string, any>;
let creates: number;
let lastCreateParams: Record<string, unknown> | undefined;
let movedFiles: Array<{ source: string; destination: string }>;
let volumes: Map<string, any>;

function fakeSandbox(id: string, state = "started") {
  const ptyOutputs = new Map<string, (data: Uint8Array) => void>();
  const processSessions = new Map<string, any>();
  const contexts = new Map<string, any>();
  const sandbox: any = {
    id, name: `chusky-${id}`, state, recoverable: false, networkBlockAll: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    refreshData: async () => undefined,
    updateNetworkSettings: async (settings: { networkBlockAll?: boolean }) => { sandbox.networkBlockAll = settings.networkBlockAll; },
    getUserHomeDir: async () => "/home/user",
    getWorkDir: async () => "/home/user",
    getMetricsLatest: async () => ({ cpuUsedPct: 12, memUsed: 100, memTotal: 1000, timestamp: new Date() }),
    waitForResizeComplete: async () => undefined,
    resize: async () => undefined,
    setAutostopInterval: async () => undefined,
    setAutoPauseInterval: async () => undefined,
    setTtl: async () => undefined,
    setAutoArchiveInterval: async () => undefined,
    setAutoDeleteInterval: async () => undefined,
    setLabels: async (labels: Record<string, string>) => { sandbox.labels = { ...(sandbox.labels ?? {}), ...labels }; return sandbox.labels; },
    refreshActivity: async () => undefined,
    start: async () => { sandbox.state = "started"; },
    recover: async () => { sandbox.state = "started"; sandbox.recoverable = false; },
    pause: async () => { sandbox.state = "paused"; },
    stop: async () => { sandbox.state = "stopped"; },
    waitUntilStarted: async () => { sandbox.state = "started"; },
    waitUntilStopped: async () => { sandbox.state = "stopped"; },
    archive: async () => { sandbox.state = "archived"; },
    delete: async () => { sandbox.state = "destroyed"; sandboxes.delete(id); },
    process: {
      executeCommand: async (command: string) => { if (sandbox.commandError) throw sandbox.commandError; return { exitCode: sandbox.commandExitCode ?? 0, result: sandbox.commandResult ?? `ran:${command}` }; },
      createPty: async ({ id: ptyId, onData }: any) => { ptyOutputs.set(ptyId, onData); onData(new TextEncoder().encode("$ ")); return { sessionId: ptyId, isConnected: () => true, waitForConnection: async () => undefined, sendInput: async (input: string) => onData(new TextEncoder().encode(`ran:${input}`)), disconnect: async () => undefined }; },
      connectPty: async (ptyId: string, { onData }: any) => { ptyOutputs.set(ptyId, onData); return { sessionId: ptyId, isConnected: () => true, waitForConnection: async () => undefined, sendInput: async (input: string) => onData(new TextEncoder().encode(`ran:${input}`)), disconnect: async () => undefined }; },
      listPtySessions: async () => [...ptyOutputs.keys()].map((ptyId) => ({ id: ptyId, active: true })),
      resizePtySession: async () => undefined,
      killPtySession: async (ptyId: string) => { ptyOutputs.delete(ptyId); },
      createSession: async (sessionId: string) => { processSessions.set(sessionId, { sessionId, commands: [] }); },
      listSessions: async () => [...processSessions.values()],
      getSession: async (sessionId: string) => processSessions.get(sessionId),
      executeSessionCommand: async (sessionId: string, request: any) => { const commandId = `cmd-${Date.now()}`; const session = processSessions.get(sessionId); session.commands.push({ id: commandId, command: request.command, exitCode: 0 }); return { cmdId: commandId, output: `ran:${request.command}`, stdout: `ran:${request.command}`, stderr: "", exitCode: 0 }; },
      getSessionCommandLogs: async (_sessionId: string, commandId: string, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void) => {
        if (onStdout) { onStdout(`live:${commandId}:1`); onStdout(`live:${commandId}:2`); }
        if (onStderr) onStderr(`err:${commandId}`);
        return { output: `logs:${commandId}`, stdout: `logs:${commandId}`, stderr: "" };
      },
      sendSessionCommandInput: async () => undefined,
      deleteSession: async (sessionId: string) => { processSessions.delete(sessionId); },
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
      downloadFileStream: async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([Buffer.from("persisted content")]);
      },
      uploadFileStream: async () => undefined,
      createFolder: async () => undefined,
      moveFiles: async (source: string, destination: string) => { movedFiles.push({ source, destination }); },
      deleteFile: async () => undefined,
      replaceInFiles: async (files: string[]) => files.map((file) => ({ file, success: true })),
      setFilePermissions: async () => undefined,
    },
    getPreviewLink: async (port: number) => ({ url: sandbox.previewUrl ?? `https://preview.test/${port}` }),
    getSignedPreviewUrl: async (port: number) => ({ url: sandbox.previewUrl ?? `https://preview.test/signed/${port}` }),
    downloadUrl: async (path: string, ttlSeconds: number) => `https://download.test/${encodeURIComponent(path)}?ttl=${ttlSeconds}`,
    createSnapshot: async () => undefined,
    fork: async () => undefined,
    codeInterpreter: {
      createContext: async () => { const context = { id: `ctx-${contexts.size + 1}`, language: "python", cwd: "/home/user" }; contexts.set(context.id, context); return context; },
      listContexts: async () => [...contexts.values()],
      runCode: async (code: string) => ({ stdout: `ran:${code}`, stderr: "" }),
      deleteContext: async (context: any) => { contexts.delete(context.id); },
    },
    computerUse: {
      start: async () => undefined,
      getStatus: async () => ({ status: "running" }),
      getProcessStatus: async (name: string) => ({ name, status: "running" }),
      display: { getInfo: async () => ({ displays: [{ width: 800, height: 600 }] }), getWindows: async () => ({ windows: [] }) },
      screenshot: { takeCompressed: async () => ({ screenshot: Buffer.from("image").toString("base64"), sizeBytes: 5 }), takeFullScreen: async () => ({ screenshot: Buffer.from("png").toString("base64"), sizeBytes: 3 }), takeRegion: async () => ({ screenshot: Buffer.from("png").toString("base64"), sizeBytes: 3 }) },
      mouse: { move: async (x: number, y: number) => ({ x, y }), click: async () => ({ x: 1, y: 2 }), drag: async () => ({ x: 3, y: 4 }), scroll: async () => true },
      keyboard: { type: async () => undefined, press: async () => undefined, hotkey: async () => undefined },
      accessibility: { getTree: async () => ({ root: {} }), findNodes: async () => ({ matches: [] }), focusNode: async () => undefined, invokeNode: async () => undefined, setNodeValue: async () => undefined },
    },
    createLspServer: async () => ({ start: async () => undefined, stop: async () => undefined, documentSymbols: async () => [{ name: "main", kind: 12 }], sandboxSymbols: async () => [{ name: "main", kind: 12 }], completions: async () => ({ isIncomplete: false, items: [{ label: "main" }] }) }),
    volumes: [],
  };
  sandboxes.set(id, sandbox);
  return sandbox;
}

beforeEach(async () => {
  await initStore({ memoryOnly: true });
  sandboxes = new Map();
  volumes = new Map();
  creates = 0;
  lastCreateParams = undefined;
  movedFiles = [];
});

function engine() {
  return new DaytonaEngine(() => ({
    get: async (id: string) => {
      const sandbox = sandboxes.get(id);
      if (!sandbox) throw new Error("404 sandbox not found");
      return sandbox;
    },
    create: async (params: Record<string, unknown>) => { creates++; lastCreateParams = params; return fakeSandbox(`sandbox-${creates}`); },
    fork: async (source: any, params: { name?: string }) => { const child = fakeSandbox(`fork-${creates + 1}`); child.name = params.name ?? child.name; child.labels = { agent: "chusky", user_id: "820060", parent_sandbox: source.id }; return child; },
    volume: {
      get: async (name: string, create?: boolean) => {
        const existing = volumes.get(name);
        if (existing) return existing;
        if (!create) throw new Error("404 volume not found");
        const volume = { id: `vol-${volumes.size + 1}`, name, state: "ready" };
        volumes.set(name, volume);
        return volume;
      },
      list: async () => [...volumes.values()],
      create: async (name: string) => { const volume = { id: `vol-${volumes.size + 1}`, name, state: "ready" }; volumes.set(name, volume); return volume; },
      delete: async (volume: any) => { volumes.delete(volume.name); },
    },
  } as any));
}

test("retries only transient npm registry failures while safely resetting an unregistered scaffold directory", () => {
  const command = appScaffoldCommand("vite-react", "client-portal");
  assert.match(command, /while \[ "\$attempt" -le 3 \]/);
  assert.match(command, /rm -rf "workspace\/apps\/client-portal"/);
  assert.match(command, /EAI_AGAIN\|ENOTFOUND\|ECONNRESET/);
  assert.match(command, /NPM_CONFIG_FETCH_RETRIES=2/);
  assert.match(command, /npm create vite@latest client-portal/);
});

test("creates one workspace and persists its provider ID", async () => {
  const e = engine();
  const first = await e.getOrCreateWorkspace(820001);
  const second = await e.getOrCreateWorkspace(820001);
  assert.equal(first.id, second.id);
  assert.equal(creates, 1);
  assert.equal((await getDaytonaWorkspace(820001))?.sandboxId, first.id);
  assert.equal(lastCreateParams?.autoPauseInterval, undefined);
});

test("restores npm access for a retained workspace that was previously network-blocked", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820001) as any;
  sandbox.networkBlockAll = true;
  let settings: unknown;
  sandbox.updateNetworkSettings = async (value: unknown) => {
    settings = value;
    sandbox.networkBlockAll = (value as { networkBlockAll?: boolean }).networkBlockAll;
  };

  await e.getOrCreateWorkspace(820001);

  assert.deepEqual(settings, { networkBlockAll: false });
  assert.equal(sandbox.networkBlockAll, false);
});

test("keeps normal workspace operations available when Daytona enforces a tier network policy", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820001) as any;
  sandbox.networkBlockAll = true;
  let attempts = 0;
  sandbox.updateNetworkSettings = async () => {
    attempts++;
    throw new Error("Network access is restricted and cannot be overridden at the sandbox level");
  };

  await e.getOrCreateWorkspace(820001);
  await e.getOrCreateWorkspace(820001);

  assert.equal(attempts, 1);
});

test("reports a tier-enforced network block before attempting an app scaffold", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820001) as any;
  sandbox.networkBlockAll = true;
  sandbox.updateNetworkSettings = async () => {
    throw new Error("Network access is restricted and cannot be overridden at the sandbox level");
  };

  await assert.rejects(
    () => e.app(820001, { action: "scaffold", id: "portal", framework: "vite-react" }),
    /organization tier blocks outbound network access/,
  );
});

test("recovers a retained named sandbox after the local workspace record is lost", async () => {
  const orphan = fakeSandbox("sandbox-retained");
  orphan.name = "chusky-820050";
  orphan.labels = { agent: "chusky", user_id: "820050" };
  const e = new DaytonaEngine(() => ({
    get: async (idOrName: string) => {
      if (idOrName === orphan.id || idOrName === orphan.name) return orphan;
      throw new Error("404 sandbox not found");
    },
    create: async () => { throw Object.assign(new Error("Sandbox with name chusky-820050 already exists"), { statusCode: 409 }); },
  } as any));
  const recovered = await e.getOrCreateWorkspace(820050);
  assert.equal(recovered.id, orphan.id);
  assert.equal((await getDaytonaWorkspace(820050))?.sandboxId, orphan.id);
});

test("reports an absent workspace without turning a normal status check into a tool failure", async () => {
  const result = await engine().workspace(820000, "status");
  assert.deepEqual(result, { exists: false, message: "No Daytona workspace exists yet. Use action=create, or use a file/computer tool and Chusky will create it automatically." });
});

test("persists and resumes owned Daytona process sessions", async () => {
  const e = engine();
  const created = await e.session(820060, { action: "create", id: "build-session" });
  assert.equal(created.sessionId, "build-session");
  assert.equal((await getDaytonaWorkspace(820060))?.processSessions?.[0]?.id, "build-session");
  const executed = await e.session(820060, { action: "execute", id: "build-session", command: "pwd" });
  assert.equal(executed.commandId?.startsWith("cmd-"), true);
  const logs = await e.session(820060, { action: "logs", id: "build-session", commandId: executed.commandId });
  assert.match(logs.output ?? "", /logs:cmd-/);
  await e.session(820060, { action: "delete", id: "build-session" });
  assert.equal((await getDaytonaWorkspace(820060))?.processSessions?.length ?? 0, 0);
});

test("streams native Daytona process-session logs with bounded callbacks", async () => {
  const e = engine();
  await e.session(820060, { action: "create", id: "stream-session" });
  const chunks: string[] = [];
  const result = await e.session(820060, { action: "stream_logs", id: "stream-session", commandId: "cmd-live" }, (stream, chunk) => { chunks.push(`${stream}:${chunk}`); });
  assert.equal(result.streamed, true);
  assert.deepEqual(chunks, ["stdout:live:cmd-live:1", "stdout:live:cmd-live:2", "stderr:err:cmd-live"]);
});

test("creates an account-owned persistent volume and mounts it on the next sandbox creation", async () => {
  const e = engine();
  const created = await e.volume(820063, { action: "create", name: "research" });
  assert.equal(created.name, "research");
  const mounted = await e.volume(820063, { action: "mount", name: "research", mountPath: "/home/user/workspace/data", subpath: "reports" });
  assert.equal(mounted.mountPath, "/home/user/workspace/data");
  await e.getOrCreateWorkspace(820063);
  assert.deepEqual(lastCreateParams?.volumes, [{ volumeId: created.id, mountPath: "/home/user/workspace/data", subpath: "reports" }]);
  await assert.rejects(() => e.volume(820063, { action: "unmount", name: "research" }), /fixed for an existing sandbox/);
});

test("supports interpreter contexts, sandbox metrics, and LSP inspection", async () => {
  const e = engine();
  const context = await e.code(820061, { action: "create_context" });
  assert.equal(context.created, true);
  const result = await e.code(820061, { action: "run", contextId: context.contextId, code: "print(1)" });
  assert.match(result.stdout ?? "", /print\(1\)/);
  const metrics = await e.sandbox(820061, { action: "metrics" }) as any;
  assert.equal(metrics.sandboxId, "sandbox-1");
  assert.equal(metrics.cpuUsedPct, 12);
  const symbols = await e.lsp(820061, { action: "document_symbols", path: "workspace/src/index.ts" }) as any;
  assert.equal(symbols.symbols[0].name, "main");
  await e.code(820061, { action: "delete_context", contextId: context.contextId });
});

test("reports sandbox health and capability evidence", async () => {
  const result = await engine().sandbox(820064, { action: "health" }) as any;
  assert.equal(result.healthy, true);
  assert.equal(result.capabilities.computerUse, true);
  assert.equal(result.capabilities.streamingFiles, true);
  assert.equal(result.metrics.cpuUsedPct, 12);
});

test("creates an account-owned fork and refuses arbitrary sandbox IDs", async () => {
  const e = engine();
  const fork = await e.sandbox(820062, { action: "fork", name: "analysis-fork" }) as any;
  assert.equal(fork.forked, true);
  assert.equal((await getDaytonaWorkspace(820062))?.forks?.[0]?.id, fork.sandboxId);
  await assert.rejects(() => e.sandbox(820062, { action: "status", sandboxId: "foreign-sandbox" }), /not an owned/);
});

test("writes generated binary media into the user's workspace", async () => {
  const e = engine();
  const result = await e.writeBinaryFile(820021, "generated/images/hero.png", Buffer.from([1, 2, 3]));
  assert.deepEqual(result, { path: "generated/images/hero.png", bytes: 3 });
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

test("computer-use accessibility output redacts credential-shaped fields and values", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820006) as any;
  sandbox.computerUse.accessibility.getTree = async () => ({ password: "secret", inputValue: "user@example.com", visibleText: "Call +1 (555) 123-4567" });
  const tree = await e.computer(820006, { action: "accessibility_tree" }) as any;
  assert.deepEqual(tree, { password: "[redacted]", inputValue: "[redacted]", visibleText: "Call [redacted phone]" });
});

test("computer process diagnostics use Daytona desktop names and a bare status defaults to noVNC", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820061) as any;
  const names: string[] = [];
  sandbox.computerUse.getProcessStatus = async (name: string) => { names.push(name); return { name, status: "running" }; };
  await e.computer(820061, { action: "process_status" });
  await e.computer(820061, { action: "process_status", processName: "browser" });
  assert.deepEqual(names, ["novnc", "novnc"]);
  await assert.rejects(() => e.computer(820061, { action: "process_logs", processName: "postgres" }), /novnc, x11vnc, xfce4, or xvfb/);
});

test("computer-use rejects invalid coordinates and oversized keyboard input", async () => {
  const e = engine();
  await assert.rejects(() => e.computer(820007, { action: "mouse_click", x: -1, y: 20 }), /coordinate/);
  await assert.rejects(() => e.computer(820007, { action: "keyboard_type", text: "x".repeat(4001) }), /1-4000/);
});

test("retries only the Computer Use startup handshake after a transient transport disconnect", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820071) as any;
  let starts = 0;
  sandbox.computerUse.start = async () => {
    starts++;
    if (starts === 1) throw new Error("connection is shut down");
  };
  const screenshot = await e.computer(820071, { action: "screenshot" }) as any;
  assert.equal(starts, 2);
  assert.equal(screenshot.__daytonaScreenshot, true);
});

test("vault login falls back to standard accessibility labels or requests owner interaction without typing", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820072) as any;
  const writes: string[] = [];
  sandbox.computerUse.accessibility.findNodes = async ({ name }: { name?: string }) => {
    if (name === "Email") return { matches: [{ nodeId: "email" }] };
    if (name === "Password") return { matches: [{ nodeId: "password" }] };
    if (name === "Continue") return { matches: [{ nodeId: "submit" }] };
    return { matches: [] };
  };
  sandbox.computerUse.accessibility.setNodeValue = async (id: string) => { writes.push(id); };
  const loggedIn = await e.vaultLogin(820072, {
    origin: "https://example.com", loginUrl: "https://example.com/login", usernameFieldLabel: "Email or username", passwordFieldLabel: "Password", submitButtonLabel: "Sign in", username: "private", password: "private",
  });
  assert.deepEqual(writes, ["email", "password"]);
  assert.equal(loggedIn.authenticated, false);
  sandbox.computerUse.accessibility.findNodes = async () => ({ matches: [] });
  const needsOwner = await e.vaultLogin(820072, {
    origin: "https://example.com", loginUrl: "https://example.com/login", usernameFieldLabel: "Email", passwordFieldLabel: "Password", submitButtonLabel: "Sign in", username: "private", password: "private",
  });
  assert.equal(needsOwner.needsUserInteraction, true);
  assert.deepEqual(writes, ["email", "password"]);
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

test("browser navigation captures a sanitized address-bar redirect observation when available", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(8200101) as any;
  sandbox.computerUse.accessibility.getTree = async () => ({ root: { role: "textbox", value: "https://redirect.example/final?token=private" } });
  const opened = await e.browser(8200101, { action: "open", url: "https://start.example" }) as any;
  assert.equal(opened.observedUrl, "https://redirect.example/final");
  assert.equal(opened.observationMethod, "address_bar");
  assert.equal((await getDaytonaWorkspace(8200101))?.browser?.lastUrl, "https://redirect.example/final");
});

test("browser wait_download only returns after a file has a stable non-zero size", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(8200102) as any;
  let calls = 0;
  sandbox.fs.listFiles = async () => {
    calls++;
    return calls === 1 ? [] : [{ name: "report.pdf", path: "workspace/Downloads/report.pdf", isDir: false, size: 42 }];
  };
  const result = await e.browser(8200102, { action: "wait_download", path: "workspace/Downloads/report.pdf", timeoutSeconds: 5 }) as any;
  assert.equal(result.stable, true);
  assert.equal(result.file.path, "workspace/Downloads/report.pdf");
  assert.ok(calls >= 4);
});

test("serializes browser control with leases and promotes a download to an artifact", async () => {
  const e = engine();
  const lease = await e.browser(820011, { action: "session_acquire", sessionName: "research" }) as any;
  assert.match(lease.sessionId, /^br_/);
  await assert.rejects(() => e.browser(820011, { action: "session_acquire", sessionName: "other" }), /already leased/);
  const opened = await e.browser(820011, { action: "open", sessionId: lease.sessionId, url: "https://example.com" }) as any;
  assert.equal(opened.opened, "https://example.com");
  const artifact = await e.browser(820011, { action: "download_register", sessionId: lease.sessionId, path: "workspace/Downloads/report.md", type: "report", name: "report.md" }) as any;
  assert.equal(artifact.type, "report");
  const listed = await e.browser(820011, { action: "session_list" }) as any;
  assert.equal(listed.sessions.length, 1);
  await e.browser(820011, { action: "session_release", sessionId: lease.sessionId });
});

test("returns a signed browser-accessible preview URL and rejects provider URL failures", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820014) as any;
  const preview = await e.preview(820014, 3003);
  assert.equal(preview.sandboxId, sandbox.id);
  assert.equal(preview.port, 3003);
  assert.equal(preview.url, "https://preview.test/signed/3003");
  assert.ok((preview.expiresAt ?? 0) > Date.now());
  sandbox.previewUrl = "localhost:3003";
  await assert.rejects(() => e.preview(820014, 3003), /invalid preview URL/);
});

test("creates a short-lived private handoff into the retained noVNC browser", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820017) as any;
  const requested: Array<{ port: number; ttl: number }> = [];
  sandbox.getSignedPreviewUrl = async (port: number, ttl: number) => {
    requested.push({ port, ttl });
    return { url: `https://preview.test/signed/${port}?handoff=opaque` };
  };
  const handoff = await e.browserHandoff(820017, "a CAPTCHA");
  assert.equal(handoff.sandboxId, sandbox.id);
  assert.match(handoff.url, /^https:\/\/preview\.test\/signed\/6080\?/);
  assert.equal(requested[0]?.ttl, 300);
  assert.match(handoff.message, /same retained browser/i);
});

test("rejects a Daytona dashboard URL as a private browser handoff", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820018) as any;
  sandbox.computerUse.getProcessStatus = async () => ({ status: "running" });
  sandbox.getSignedPreviewUrl = async () => ({ url: "https://app.daytona.io/login" });
  await assert.rejects(() => e.browserHandoff(820018), /dashboard login URL/i);
});

test("app projects create an isolated branch, verify before preview, retain evidence, and stop cleanly", async () => {
  const e = engine();
  const scaffolded = await e.app(820015, { action: "scaffold", id: "client-portal", framework: "vite-react" }) as any;
  assert.equal(scaffolded.status, "scaffolded");
  assert.equal(scaffolded.path, "workspace/apps/client-portal");
  assert.equal(scaffolded.branch, "chusky/client-portal");
  const verified = await e.app(820015, { action: "verify", id: "client-portal" }) as any;
  assert.equal(verified.status, "verified");
  assert.equal(verified.verification.status, "passed");
  assert.deepEqual(verified.verification.checks.map((check: any) => check.name), ["typecheck", "lint", "test", "build"]);
  const running = await e.app(820015, { action: "start", id: "client-portal", expiresInSeconds: 120 }) as any;
  assert.equal(running.status, "running");
  assert.equal(running.verification.checks.at(-1).name, "health");
  assert.match(running.url, /^https:\/\/preview\.test\/signed\/5173$/);
  assert.ok(running.ptySessionId);
  const logs = await e.app(820015, { action: "logs", id: "client-portal" }) as any;
  assert.match(logs.output, /ran:/);
  const refreshed = await e.app(820015, { action: "status", id: "client-portal" }) as any;
  assert.equal(refreshed.status, "running");
  const screenshot = await e.app(820015, { action: "visual", id: "client-portal" }) as any;
  assert.equal(screenshot.__daytonaScreenshot, true);
  const reviewed = await e.app(820015, { action: "review", id: "client-portal", passed: true, summary: "Readable desktop layout and expected content are visible." }) as any;
  assert.equal(reviewed.verification.visual.status, "passed");
  const release = await e.app(820015, { action: "release", id: "client-portal", target: "Vercel preview" }) as any;
  assert.equal(release.status, "ready_to_publish");
  assert.equal(release.release.status, "awaiting_approval");
  const stopped = await e.app(820015, { action: "stop", id: "client-portal" }) as any;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.ptySessionId, undefined);
});

test("app preview refuses a failed production verification and never starts its server", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820016) as any;
  await e.app(820016, { action: "scaffold", id: "broken-app", framework: "nextjs" });
  sandbox.commandExitCode = 1;
  await assert.rejects(() => e.app(820016, { action: "start", id: "broken-app" }), /verification failed/);
  const app = (await e.app(820016, { action: "status", id: "broken-app" })) as any;
  assert.equal(app.status, "failed");
  assert.equal(app.ptySessionId, undefined);
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

test("returns a short-lived signed URL for an owned artifact without downloading bytes", async () => {
  const e = engine();
  const result = await e.artifact(820011, { action: "create", type: "report", name: "signed.md", content: "# Signed" }) as any;
  const signed = await e.artifact(820011, { action: "download_url", id: result.id, ttlSeconds: 120 }) as any;
  assert.equal(signed.id, result.id);
  assert.match(signed.url, /ttl=120/);
  assert.ok(signed.expiresAt > Date.now());
});

test("registers DOCX as a first-class artifact after Daytona structure validation", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820012) as any;
  const result = await e.artifact(820012, { action: "register", type: "docx", path: "workspace/artifacts/brief.docx" }) as any;
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.type, "docx");
  assert.equal(result.name, "brief.docx");
  assert.equal(result.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("normalizes generated PDF paths and names before delivery", async () => {
  const e = engine();
  const result = await e.artifact(820016, { action: "register", type: "pdf", path: "workspace/artifacts/brief" }) as any;
  assert.equal(result.name, "brief.pdf");
  assert.equal(result.path, "workspace/artifacts/brief.pdf");
  assert.equal(result.contentType, "application/pdf");
  assert.deepEqual(movedFiles, [{ source: "workspace/artifacts/brief", destination: "workspace/artifacts/brief.pdf" }]);
});

test("does not decode binary Daytona files as text", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820017) as any;
  sandbox.fs.downloadFile = async () => Buffer.from("%PDF-1.7\n", "ascii");
  await assert.rejects(() => e.readFile(820017, "workspace/artifacts/brief"), /PDF file and cannot be read as text/);
});

test("does not persist a structured artifact when Daytona validation fails", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820013) as any;
  sandbox.commandExitCode = 2;
  sandbox.commandResult = "invalid Office Open XML package";
  await assert.rejects(() => e.artifact(820013, { action: "register", type: "docx", path: "workspace/artifacts/broken.docx" }), /DOCX validation failed/);
  assert.equal((await getSession(820013)).artifacts?.length ?? 0, 0);
});

test("runs the visual renderability gate after structural artifact validation", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820018) as any;
  const commands: string[] = [];
  const originalExecute = sandbox.process.executeCommand;
  sandbox.process.executeCommand = async (command: string, ...rest: unknown[]) => {
    commands.push(command);
    return originalExecute.call(sandbox.process, command, ...rest);
  };
  await e.artifact(820018, { action: "register", type: "presentation", path: "workspace/artifacts/visual.pptx" });
  assert.equal(commands.length, 2);
  const validationScript = commands[0].match(/base64\.b64decode\('([^']+)'\)/)?.[1];
  assert.ok(validationScript);
  assert.match(Buffer.from(validationScript, "base64").toString("utf8"), /target\.lstrip\('\/'\)/);
  assert.match(commands[1], /base64\.b64decode/);
  assert.match(Buffer.from(commands[1].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8"), /rendered all/);
});

test("requires complete-page DOCX rendering instead of silently skipping QA", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820019) as any;
  const commands: string[] = [];
  const originalExecute = sandbox.process.executeCommand;
  sandbox.process.executeCommand = async (command: string, ...rest: unknown[]) => {
    commands.push(command);
    return originalExecute.call(sandbox.process, command, ...rest);
  };
  await e.artifact(820019, { action: "register", type: "docx", path: "workspace/artifacts/brief.docx" });
  const visualScript = Buffer.from(commands[1].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  // require_renderer is now emitted as a real Python boolean (capital True/False)
  assert.match(visualScript, /require_renderer=True/);
  assert.match(visualScript, /CHUSKY_RENDERER_UNAVAILABLE/);
  assert.match(visualScript, /libreoffice-profile/);
});

test("creates a structured PDF in Daytona before registering it", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820025) as any;
  let generatorScript = "";
  const commands: string[] = [];
  sandbox.fs.uploadFile = async (contents: Buffer, path: string) => {
    if (path.endsWith(".py")) generatorScript = Buffer.from(contents).toString("utf8");
  };
  sandbox.process.executeCommand = async (command: string) => {
    commands.push(command);
    return { exitCode: 0, result: "ok" };
  };
  const result = await e.createPdf(820025, {
    title: "Quarterly Report",
    sections: [{ heading: "Summary", body: "Verified.", bullets: ["One"], table: { headers: ["Metric", "Value"], rows: [["Revenue", "100"]] }, columnWidths: [3, 1], chart: undefined }],
    style: { preset: "brand", fontFamily: "serif", header: "Quarterly board report", footer: "Private and confidential", includePageNumbers: false, author: "Chusky QA" },
  });
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.type, "pdf");
  assert.match(generatorScript, /from reportlab\.platypus/);
  assert.match(generatorScript, /LongTable/);
  assert.match(generatorScript, /ImageReader/);
  assert.match(generatorScript, /PdfReader/);
  assert.match(generatorScript, /fontName=style\['fontName'\]/);
  assert.match(generatorScript, /ROWBACKGROUNDS/);
  assert.match(generatorScript, /columnWidths/);
  assert.match(generatorScript, /includePageNumbers/);
  assert.doesNotMatch(generatorScript, /write_pure_pdf/);
  assert.match(commands[0], /^python3 artifacts\/\.chusky\/pdf-generator-/);
  const visualScript = Buffer.from(commands[2].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  assert.match(visualScript, /kind="pdf"/);
  // require_renderer is now emitted as a real Python boolean (capital True/False)
  assert.match(visualScript, /require_renderer=True/);
});

test("makes optional PDF chrome non-fatal and emits hard smoke checks", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820029) as any;
  let generatorScript = "";
  sandbox.fs.uploadFile = async (contents: Buffer, path: string) => {
    if (path.endsWith(".py")) generatorScript = Buffer.from(contents).toString("utf8");
  };
  sandbox.process.executeCommand = async () => ({ exitCode: 0, result: "ok" });
  await e.createPdf(820029, {
    title: "Long playbook",
    sections: Array.from({ length: 8 }, (_, index) => ({ heading: `Section ${index + 1}`, body: "Substantive operational detail." })),
    style: { logoPath: "workspace/missing-logo.png" },
  });
  assert.match(generatorScript, /def _noop\(canvas, document\):/);
  assert.match(generatorScript, /on_first=draw_page if callable\(draw_page\) else _noop/);
  assert.match(generatorScript, /PDF logo skipped/);
  assert.doesNotMatch(generatorScript, /raise FileNotFoundError\('PDF logo does not exist/);
  assert.match(generatorScript, /expected_min_pages=3 if len\(payload\.get\('sections'\) or \[\]\) >= 8 else 1/);
  assert.match(generatorScript, /PDF page-count verification failed/);
});

test("treats blank optional brand fields as omitted", async () => {
  const e = engine();
  const result = await e.createPdf(820027, {
    title: "Blank brand fields",
    brand: { companyName: "", tagline: "", header: "", footer: "", logoPath: "" },
    sections: [{ body: "The optional brand identity is omitted safely." }],
  });
  assert.equal(result.generated, true);
  assert.equal(result.type, "pdf");
});

test("rejects unsupported PDF font themes and invalid table column weights before generation", async () => {
  const e = engine();
  await assert.rejects(() => e.createPdf(820027, { title: "Bad font", sections: [{ body: "Nope" }], style: { fontFamily: "Comic Sans" } }), /fontFamily must be sans, serif, or mono/);
  await assert.rejects(() => e.createPdf(820027, { title: "Bad widths", sections: [{ table: [["One", "Two"]], columnWidths: [1] }] }), /columnWidths must contain one width/);
});

test("creates branded DOCX and XLSX artifacts with native Office builders", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820028) as any;
  const uploads: Array<{ path: string; bytes: Buffer }> = [];
  sandbox.fs.uploadFile = async (contents: Buffer, path: string) => { uploads.push({ path, bytes: Buffer.from(contents) }); };
  const docx = await e.createDocument(820028, {
    title: "Board brief",
    sections: [{ heading: "Summary", body: "Ready for review.", table: { headers: ["Metric", "Value"], rows: [["Revenue", "100"]] } }],
    brand: { companyName: "ZiloShift", tagline: "Work. Flex. Earn.", preset: "brand", primary: "123B5D", accent: "0F766E" },
  });
  const xlsx = await e.createSpreadsheet(820028, {
    title: "Performance report",
    sheets: [{ name: "Overview", rows: { headers: ["Metric", "Value"], rows: [["Revenue", "100"], ["Margin", "25%"]] } }],
    brand: { companyName: "ZiloShift", preset: "modern", primary: "312E81", accent: "DB2777" },
  });
  assert.equal(docx.type, "docx");
  assert.equal(xlsx.type, "spreadsheet");
  assert.ok(uploads.some((item) => item.path.endsWith(".docx") && item.bytes.subarray(0, 2).equals(Buffer.from("PK"))));
  assert.ok(uploads.some((item) => item.path.endsWith(".xlsx") && item.bytes.subarray(0, 2).equals(Buffer.from("PK"))));
});

test("moves PDF generation to the isolated renderer when the workspace lacks ReportLab", async () => {
  const source = fakeSandbox("source-pdf");
  const renderer = fakeSandbox("renderer-pdf");
  const generated = Buffer.from("%PDF-1.4\n1 0 obj\n%%EOF");
  source.process.executeCommand = async (command: string) => command.includes("pdf-generator-")
    ? { exitCode: 1, result: "ReportLab is unavailable" }
    : { exitCode: 0, result: "validated" };
  source.fs.uploadFile = async (bytes: Buffer, path: string) => {
    if (path.endsWith(".py")) return;
    assert.match(path, /^artifacts\/\.chusky\/attempt-[0-9a-f-]+-Renderer_Fallback\.pdf$/);
    assert.deepEqual(bytes, generated);
  };
  renderer.process.executeCommand = async () => ({ exitCode: 0, result: "generated" });
  renderer.fs.downloadFile = async (path: string) => path.endsWith(".pdf") ? generated : Buffer.from("script");
  const e = new DaytonaEngine(() => ({
    get: async () => source,
    create: async (params: any) => {
      if (params.labels?.purpose !== "artifact-pdf-generation") return source;
      assert.equal(params.labels.purpose, "artifact-pdf-generation");
      return renderer;
    },
  } as any));
  const result = await e.createPdf(820026, { title: "Renderer Fallback", sections: [{ body: "Generated in renderer" }] });
  assert.equal(result.generated, true);
  assert.equal(result.type, "pdf");
  assert.equal(renderer.state, "destroyed");
});

test("surfaces isolated PDF renderer exceptions and preserves the canonical dependency path", async () => {
  const source = fakeSandbox("source-pdf-error");
  const renderer = fakeSandbox("renderer-pdf-error");
  let rendererScript = "";
  source.process.executeCommand = async (command: string) => command.includes("pdf-generator-")
    ? { exitCode: 1, result: "ReportLab and pypdf are unavailable after install into workspace/.chusky/python-reportlab" }
    : { exitCode: 0, result: "validated" };
  renderer.fs.uploadFile = async (bytes: Buffer, path: string) => {
    if (path.endsWith(".py")) rendererScript = Buffer.from(bytes).toString("utf8");
  };
  renderer.process.executeCommand = async () => ({ exitCode: 1, result: "Traceback\nFileNotFoundError: PDF logo does not exist" });
  const e = new DaytonaEngine(() => ({
    get: async () => source,
    create: async (params: any) => params.labels?.purpose === "artifact-pdf-generation" ? renderer : source,
  } as any));
  await assert.rejects(
    () => e.createPdf(820030, { title: "Renderer Error", sections: [{ body: "Failure details" }] }),
    (error: unknown) => {
      assert.match(String(error), /PDF generation failed in isolated renderer/);
      assert.match(String(error), /FileNotFoundError: PDF logo does not exist/);
      return true;
    },
  );
  assert.match(rendererScript, /workspace\/\.chusky\/python-reportlab/);
  assert.doesNotMatch(rendererScript, /\/tmp\/chusky-reportlab/);
  assert.equal(renderer.state, "destroyed");
});

test("creates a presentation with the built-in generator before Daytona delivery", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820020) as any;
  const commands: string[] = [];
  let uploadedPresentation: Buffer | undefined;
  const originalExecute = sandbox.process.executeCommand;
  sandbox.process.executeCommand = async (command: string, ...rest: unknown[]) => {
    commands.push(command);
    return originalExecute.call(sandbox.process, command, ...rest);
  };
  sandbox.fs.uploadFile = async (contents: Buffer) => { uploadedPresentation = Buffer.from(contents); };
  const result = await e.createPresentation(820020, {
    title: "Quarterly review",
    slides: [{
      title: "Overview",
      bullets: ["Revenue grew"],
      table: [["Metric", "Value"], ["Revenue", "10"]],
    }],
  }) as any;
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.generated, true);
  assert.equal(result.type, "presentation");
  assert.equal(result.slideCount, 2);
  assert.equal(commands.length, 2);
  assert.ok(uploadedPresentation?.subarray(0, 2).equals(Buffer.from("PK")));
  assert.doesNotMatch(commands.join("\n"), /python-pptx|pip install/);
  const structureScript = Buffer.from(commands[0].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  const visualScript = Buffer.from(commands[1].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  assert.match(structureScript, /target\.startswith\('\/'\)/);
  // QA uses the exact resolved path from registration, relative to SDK home.
  assert.match(visualScript, /path=os\.path\.abspath\(path\)/);
  // Every structured Office artifact is required to pass complete-page rendering.
  assert.match(visualScript, /require_renderer=True/);
});

test("creates chart-heavy decks with complete root-relative OOXML chart relationships", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820025) as any;
  let uploadedPresentation: Buffer | undefined;
  sandbox.fs.uploadFile = async (contents: Buffer) => { uploadedPresentation = Buffer.from(contents); };
  const result = await e.createPresentation(820025, {
    title: "Chart integrity",
    slides: Array.from({ length: 8 }, (_, index) => ({
      title: `Slide ${index + 1}`,
      ...(index >= 5 ? { chart: { categories: ["Q1", "Q2", "Q3"], series: [{ name: "Revenue", values: [10 + index, 20 + index, 30 + index] }] } } : { body: "Narrative content" }),
      notes: `Notes for slide ${index + 1}`,
    })),
  }) as any;
  assert.equal(result.generated, true);
  const archive = await JSZip.loadAsync(uploadedPresentation!);
  const names = new Set(Object.entries(archive.files).filter(([, entry]) => !entry.dir).map(([name]) => name));
  for (const slideNumber of [7, 8, 9]) {
    const rels = await archive.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)?.async("text");
    const target = rels?.match(/Target="(\/ppt\/charts\/chart\d+\.xml)"/)?.[1];
    assert.ok(target, `slide ${slideNumber} should reference a chart`);
    assert.ok(names.has(target!.slice(1)), `missing packaged chart target ${target}`);
  }
});

test("normalizes empty and header-row table shapes without aborting a presentation", async () => {
  const e = engine();
  const result = await e.createPresentation(820022, {
    title: "Table compatibility",
    slides: [
      { title: "Narrative", table: [] },
      { title: "Metrics", table: { headers: ["Metric", "Value"], rows: [["Revenue", 10_000_000]] } },
    ],
  }) as any;
  assert.equal(result.generated, true);
  assert.equal(result.slideCount, 3);
});

test("applies presentation themes and layout-aware slide primitives", async () => {
  const e = engine();
  const result = await e.createPresentation(820023, {
    title: "Designed review",
    style: { preset: "modern", primary: "123456", accent: "D946EF", footer: "Confidential", includeSlideNumbers: true },
    slides: [
      { title: "Highlights", layout: "metrics", metrics: [{ label: "Growth", value: "42%", detail: "Year over year" }, { label: "Customers", value: "128" }] },
      { title: "What matters", layout: "quote", quote: "Make the next decision obvious.", body: "A concise operating principle." },
    ],
  }) as any;
  assert.equal(result.generated, true);
  assert.equal(result.slideCount, 3);
});

test("fits a full-bleed background image behind readable slide text", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820024) as any;
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  sandbox.fs.downloadFile = async (path: string) => {
    assert.equal(path, "workspace/hero.png");
    return onePixelPng;
  };
  const result = await e.createPresentation(820024, {
    title: "Background treatment",
    slides: [{
      title: "A readable message over imagery",
      layout: "background",
      backgroundImagePath: "workspace/hero.png",
      backgroundImageAltText: "A product team collaborating in an office",
      overlayOpacity: 58,
      textColor: "FFFFFF",
      body: "The scrim and left safe zone keep this message readable over a busy image.",
    }],
  }) as any;
  assert.equal(result.generated, true);
  assert.equal(result.slideCount, 2);
});

test("rejects an overlapping table and chart in a generated presentation", async () => {
  const e = engine();
  await assert.rejects(
    () => e.createPresentation(820021, {
      title: "Invalid layout",
      slides: [{
        title: "One slide",
        table: [["A"]],
        chart: { categories: ["Q1"], series: [{ name: "Revenue", values: [1] }] },
      }],
    }),
    /cannot include both table and chart/,
  );
});

test("QA failure leaves no record and retries the same file from SDK home", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820030) as any;
  sandbox.getUserHomeDir = async () => "/custom/home";
  let failVisual = true;
  sandbox.process.executeCommand = async (command: string, cwd: string) => {
    assert.equal(cwd, "/custom/home");
    const script = Buffer.from(command.match(/base64\.b64decode\('([^']+)'\)/)![1], "base64").toString();
    return { exitCode: script.includes("require_renderer") && failVisual ? 2 : 0, result: "Renderer setup failed" };
  };
  const args = { action: "register", type: "pdf", path: "artifacts/form.pdf" };
  await assert.rejects(() => e.artifact(820030, args), /visual QA failed for 'artifacts\/form.pdf'/);
  assert.equal((await getSession(820030)).artifacts?.length ?? 0, 0);
  failVisual = false;
  await e.artifact(820030, args);
  assert.equal((await getSession(820030)).artifacts?.length, 1);
});

test("successful artifact registration replay reuses the logical artifact identity", async () => {
  const e = engine();
  const first = await e.artifact(820041, { action: "register", type: "image", path: "workspace/logo.png" }) as any;
  const replay = await e.artifact(820041, { action: "register", type: "image", path: "workspace/logo.png" }) as any;
  assert.equal(replay.id, first.id);
  const artifacts = (await getSession(820041)).artifacts ?? [];
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.path, "workspace/logo.png");
});

test("failed generated replacement preserves the last known-good artifact", async () => {
  const sandbox = fakeSandbox("source-preserve");
  const files = new Map<string, Buffer>();
  sandbox.fs.uploadFile = async (bytes: Buffer, path: string) => { files.set(path, Buffer.from(bytes)); };
  sandbox.fs.downloadFile = async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`not found: ${path}`);
    return Buffer.from(bytes);
  };
  sandbox.fs.getFileDetails = async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`not found: ${path}`);
    return { size: bytes.length, isDir: false };
  };
  sandbox.fs.moveFiles = async (source: string, destination: string) => {
    const bytes = files.get(source);
    if (!bytes) throw new Error(`not found: ${source}`);
    files.set(destination, Buffer.from(bytes));
    files.delete(source);
  };
  let failVisual = false;
  sandbox.process.executeCommand = async (command: string) => {
    const encoded = command.match(/base64\.b64decode\('([^']+)'\)/)?.[1];
    const script = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    return script.includes("require_renderer") && failVisual
      ? { exitCode: 2, result: "invalid rendered output" }
      : { exitCode: 0, result: "validated" };
  };
  const e = new DaytonaEngine(() => ({
    get: async () => sandbox,
    create: async () => sandbox,
  } as any));

  const first = await e.createPresentation(820042, { title: "Stable deck", slides: [{ title: "Version A", body: "Known good" }] });
  const originalBytes = Buffer.from(files.get(first.path)!);
  failVisual = true;
  await assert.rejects(
    () => e.createPresentation(820042, { title: "Stable deck", slides: [{ title: "Version B", body: "Invalid replacement" }] }),
    /visual QA failed/,
  );
  assert.deepEqual(files.get(first.path), originalBytes);
  const artifacts = (await getSession(820042)).artifacts ?? [];
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.id, first.id);
});

test("recovers an omitted workspace prefix before validation and delivery", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820031) as any;
  sandbox.fs.getFileDetails = async (path: string) => {
    if (path !== "workspace/form.pdf") throw new Error("no such file or directory");
    return { size: 200 };
  };
  const result = await e.artifact(820031, { action: "register", type: "pdf", path: "form.pdf" }) as any;
  assert.equal(result.path, "workspace/form.pdf");
});

test("does not collapse distinct case-sensitive files during path recovery", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820032) as any;
  sandbox.fs.getFileDetails = async () => { throw new Error("no such file or directory"); };
  sandbox.fs.listFiles = async () => [{ path: "a/Form.pdf" }, { path: "a/form.pdf" }];
  await assert.rejects(() => e.artifact(820032, { action: "register", type: "pdf", path: "form.pdf" }), /matched multiple/);
});

for (const outcome of ["success", "invalid-document", "missing-tools", "create-failed", "upload-failed"]) {
  test("isolated renderer " + outcome + " preserves the workspace and cleans up", async () => {
    const source = fakeSandbox("owned-source");
    const renderer = fakeSandbox("temporary-renderer");
    let rendererCreated = false;
    let uploaded = false;
    source.process.executeCommand = async (command: string) => {
      const script = Buffer.from(command.match(/base64\.b64decode\('([^']+)'\)/)![1], "base64").toString();
      return { exitCode: script.includes("require_renderer") ? 3 : 0, result: "CHUSKY_RENDERER_UNAVAILABLE" };
    };
    source.fs.downloadFile = async (path: string) => {
      assert.equal(path, "workspace/form.docx");
      return Buffer.from("original document");
    };
    renderer.fs.uploadFile = async (bytes: Buffer, path: string) => {
      assert.equal(bytes.toString(), "original document");
      assert.equal(path, "document.docx");
      if (outcome === "upload-failed") throw new Error("upload failed");
      uploaded = true;
    };
    renderer.process.executeCommand = async () => ({
      exitCode: outcome === "invalid-document" ? 2 : outcome === "missing-tools" ? 3 : 0,
      result: outcome === "success" ? "visual QA passed: rendered all 2 page(s)" : "renderer failure",
    });
    const e = new DaytonaEngine(() => ({
      get: async () => source,
      create: async (params: any) => {
        if (params.labels.purpose !== "artifact-qa") return source;
        assert.equal(params.networkBlockAll, true);
        assert.deepEqual(params.resources, { cpu: 2, memory: 4, disk: 8 });
        assert.equal(params.autoDeleteInterval, 0);
        assert.equal(params.ttlMinutes, 30);
        assert.equal(params.labels.source_sandbox, source.id);
        assert.match(params.image.dockerfile, /libreoffice-writer/);
        assert.match(params.image.dockerfile, /poppler-utils/);
        if (outcome === "create-failed") throw new Error("provider failure");
        rendererCreated = true;
        return renderer;
      },
    } as any));
    const call = () => e.artifact(820040, { action: "register", type: "docx", path: "workspace/form.docx" });
    if (outcome === "success") {
      const artifact = await call() as any;
      assert.equal(artifact.sandboxId, source.id);
      assert.equal(artifact.path, "workspace/form.docx");
      assert.equal(uploaded, true);
    } else {
      await assert.rejects(call, /visual QA failed|Rendering infrastructure failed/);
      assert.equal((await getSession(820040)).artifacts?.length ?? 0, 0);
    }
    assert.equal((await getDaytonaWorkspace(820040))?.sandboxId, source.id);
    assert.equal(source.state, "started");
    if (rendererCreated) assert.equal(renderer.state, "destroyed");
  });
}

test("turns a missing artifact path into an actionable input error", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820019) as any;
  sandbox.fs.getFileDetails = async () => { throw new Error("stat workspace/missing.pptx: no such file or directory"); };
  await assert.rejects(
    () => e.artifact(820019, { action: "register", type: "presentation", path: "workspace/missing.pptx" }),
    /Artifact file was not found.*Generate the file in Daytona/,
  );
});

test("recovers a unique artifact basename when the model adds a workspace prefix", async () => {
  const e = engine();
  const sandbox = await e.getOrCreateWorkspace(820018) as any;
  sandbox.fs.getFileDetails = async (path: string) => {
    if (path === "workspace/chart.png") throw new Error("stat workspace/chart.png: no such file or directory");
    if (path === "chart.png") return { name: "chart.png", path: "chart.png", size: 2048, isDir: false };
    throw new Error(`stat ${path}: no such file or directory`);
  };
  sandbox.fs.listFiles = async () => [{ name: "chart.png", path: "chart.png", size: 2048, isDir: false }];
  const result = await e.artifact(820018, { action: "register", type: "image", path: "workspace/chart.png" }) as any;
  assert.equal(result.path, "chart.png");
  assert.equal(result.type, "image");
});

test("supports long commands up to 64000 characters and rejects commands exceeding limit", async () => {
  const e = engine();
  const longCmd = "echo " + "a".repeat(12000);
  const result = await e.execute(820030, longCmd, "workspace");
  assert.equal(result.command, longCmd);

  const tooLongCmd = "echo " + "a".repeat(65000);
  await assert.rejects(
    () => e.execute(820030, tooLongCmd, "workspace"),
    /command must be 1-64000 characters/,
  );
});
