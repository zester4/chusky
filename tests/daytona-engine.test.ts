import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore, getDaytonaWorkspace, getSession } from "../src/store.js";

let sandboxes: Map<string, any>;
let creates: number;
let lastCreateParams: Record<string, unknown> | undefined;
let movedFiles: Array<{ source: string; destination: string }>;

function fakeSandbox(id: string, state = "started") {
  const ptyOutputs = new Map<string, (data: Uint8Array) => void>();
  const sandbox: any = {
    id, name: `chusky-${id}`, state, recoverable: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    refreshData: async () => undefined,
    getUserHomeDir: async () => "/home/user",
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
      moveFiles: async (source: string, destination: string) => { movedFiles.push({ source, destination }); },
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
  assert.match(visualScript, /complete-page inspection/);
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
    sections: [{ heading: "Summary", body: "Verified.", bullets: ["One"], table: { headers: ["Metric", "Value"], rows: [["Revenue", "100"]] }, chart: undefined }],
  });
  assert.equal(result.__chuskyArtifactReady, true);
  assert.equal(result.type, "pdf");
  assert.match(generatorScript, /from reportlab\.platypus/);
  assert.match(generatorScript, /LongTable/);
  assert.match(generatorScript, /ImageReader/);
  assert.match(generatorScript, /PdfReader/);
  assert.doesNotMatch(generatorScript, /write_pure_pdf/);
  assert.match(commands[0], /^python3 artifacts\/\.chusky\/pdf-generator-/);
  const visualScript = Buffer.from(commands[2].match(/base64\.b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  assert.match(visualScript, /kind="pdf"/);
  // require_renderer is now emitted as a real Python boolean (capital True/False)
  assert.match(visualScript, /require_renderer=True/);
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
  // require_renderer is emitted as a real Python boolean False for non-required types.
  assert.match(visualScript, /require_renderer=False/);
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
