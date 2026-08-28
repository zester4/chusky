import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
let pty: any;
try { pty = require("node-pty"); } catch { pty = undefined; }

test("CLI help runs inside a real PTY", { skip: !pty }, async () => {
  const windows = process.platform === "win32";
  const shell = windows ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const command = windows
    ? `"${join(process.cwd(), "node_modules", ".bin", "tsx.cmd")}" src/cli.ts --help`
    : `"${join(process.cwd(), "node_modules", ".bin", "tsx")}" src/cli.ts --help`;
  const shellArgs = windows ? ["/d", "/s", "/c", command] : ["-lc", command];
  const terminal = pty.spawn(shell, shellArgs, { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: process.env });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error("PTY command timed out")); }, 15000);
    terminal.onData((data: string) => { output += data; });
    terminal.onExit(({ exitCode }: { exitCode: number }) => { clearTimeout(timeout); if (exitCode !== 0) reject(new Error(`PTY exited ${exitCode}: ${output}`)); else resolve(); });
  });
  assert.match(output, /setup|doctor|chat|auth/i);
});

test("supported PTY shell is available for the current platform", { skip: !pty }, () => {
  if (process.platform === "win32") assert.ok(process.env.ComSpec || process.env.POWERSHELL || process.env.SHELL);
  else assert.ok(process.env.SHELL || process.platform === "linux" || process.platform === "darwin");
});
