import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, basename, join, sep } from "node:path";
import ts from "typescript";
import { missionAwaitTransformer } from "./missionAwaitInstrumentation.mjs";

export type ProcessScenario = "complete" | "strict" | "timer" | "provider" | "approval" | "checkpoint" | "failure" | "prose" | "cancel" | "replan";
export interface ProcessFixture { userId: number; missionId: string; taskId: string; scenario: ProcessScenario }
export interface ProcessProofInput { mode: "prepare" | "run" | "recover"; now: number; userId?: number; fixture?: ProcessFixture; memoryOnly?: boolean; scenario?: ProcessScenario }
export interface ProcessProofResult { fixture: ProcessFixture; missionStatus?: string; taskStatus?: string }

let compiledDirectory: string | undefined;
function compileProofRuntime(): string {
  if (compiledDirectory) return compiledDirectory;
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (read.error) throw new Error("Cannot read the production TypeScript configuration.");
  const configuration = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const output = mkdtempSync(join(tmpdir(), "chusky-mission-proof-"));
  const program = ts.createProgram(configuration.fileNames, { ...configuration.options, outDir: output, noEmit: false, sourceMap: false });
  const result = program.emit(undefined, undefined, undefined, false, { before: [missionAwaitTransformer([], (filename: string) => relative(root, filename).replaceAll("\\", "/"))] });
  if (result.emitSkipped) throw new Error("The instrumented production runtime did not compile.");
  compiledDirectory = output;
  process.once("exit", () => {
    // Only remove the generated directory we own; never derive a deletion
    // target from fixture input, an environment variable or a broad root.
    const target = resolve(output);
    if (target.startsWith(`${resolve(tmpdir())}${sep}`) && basename(target).startsWith("chusky-mission-proof-")) rmSync(target, { recursive: true, force: true });
  });
  return output;
}

/** Kill the actual process, not an exception that runs production finally blocks. */
export function runMissionProcess(input: ProcessProofInput, killAt?: string): Promise<{ result?: ProcessProofResult; boundaries: string[]; killed: boolean }> {
  const compiled = compileProofRuntime();
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./missionProcessWorker.mjs", import.meta.url)), [JSON.stringify(input)], {
      execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, NODE_PATH: join(root, "node_modules"), MISSION_PROOF_COMPILED_DIR: compiled, TELEGRAM_BOT_TOKEN: "ci-test-telegram-token", COMPOSIO_API_KEY: "ci-test-composio-key", OPENROUTER_API_KEY: "ci-test-openrouter-key" },
    });
    const boundaries: string[] = [];
    let result: ProcessProofResult | undefined;
    let killed = false;
    let failed: string | undefined;
    const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Process proof timed out after 30 seconds.")); }, 30000);
    child.on("error", (error) => { clearTimeout(deadline); reject(error); });
    child.on("message", (message: any) => {
      if (message.kind === "boundary") {
        const boundary = `${message.id}:${message.phase}`;
        boundaries.push(boundary);
        if (boundary === killAt) { killed = true; child.kill("SIGKILL"); }
        else child.send({ kind: "continue", sequence: message.sequence });
      } else if (message.kind === "done") result = message.result;
      else if (message.kind === "failed") failed = `${message.errorClass ?? "Error"} ${message.code ?? ""} ${message.missingModule ?? ""}: ${(message.frames ?? []).join(" ")}`;
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      if (!killed && (failed || code !== 0 || !result)) reject(new Error(`Process proof worker failed without a verified result. ${failed ?? ""}`));
      else resolve({ result, boundaries, killed });
    });
  });
}
