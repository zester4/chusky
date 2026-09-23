import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const requestedVersion = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
const dryRun = args.includes("--dry-run");

if (!requestedVersion || !/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  console.error("Usage: npm run sdk:publish -- --version 1.5.0 [--dry-run]");
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(resolve("sdk", "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(resolve("sdk", "package-lock.json"), "utf8"));
const lockRoot = lockfile.packages?.[""];

if (packageJson.version !== requestedVersion) {
  throw new Error(`sdk/package.json is ${packageJson.version}; requested ${requestedVersion}`);
}
if (lockfile.version !== requestedVersion || lockRoot?.version !== requestedVersion) {
  throw new Error(`sdk/package-lock.json is not synchronized to ${requestedVersion}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const publishArgs = ["publish", "--access", "public", "--provenance", ...(dryRun ? ["--dry-run"] : [])];
console.log(`${dryRun ? "Previewing" : "Publishing"} @chusky/sdk@${requestedVersion}`);

await new Promise((resolveProcess, reject) => {
  const command = process.platform === "win32" ? "cmd.exe" : npm;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", [npm, ...publishArgs].join(" ")] : publishArgs;
  const child = spawn(command, commandArgs, { cwd: resolve("sdk"), stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`npm publish terminated by ${signal}`));
    else if (code !== 0) reject(new Error(`npm publish exited with code ${code}`));
    else resolveProcess();
  });
});
