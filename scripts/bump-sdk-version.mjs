import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const requested = process.argv[2] ?? "patch";
const packagePath = resolve("sdk", "package.json");
const lockPath = resolve("sdk", "package-lock.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(packageJson.version);

if (!match) {
  throw new Error(`sdk/package.json has an invalid version: ${packageJson.version}`);
}

const [, major, minor, patchVersion] = match.map(Number);
let next;
if (/^\d+\.\d+\.\d+$/.test(requested)) {
  next = requested;
} else if (requested === "major") {
  next = `${major + 1}.0.0`;
} else if (requested === "minor") {
  next = `${major}.${minor + 1}.0`;
} else if (requested === "patch") {
  next = `${major}.${minor}.${patchVersion + 1}`;
} else {
  throw new Error("Usage: npm run sdk:version -- [patch|minor|major|x.y.z]");
}

packageJson.version = next;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
if (lockfile.name !== packageJson.name || !lockfile.packages || typeof lockfile.packages !== "object" || !lockfile.packages[""]) {
  throw new Error("sdk/package-lock.json does not describe the SDK package");
}
lockfile.name = packageJson.name;
lockfile.version = next;
lockfile.packages[""].name = packageJson.name;
lockfile.packages[""].version = next;
await writeFile(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`);
console.log(`Chusky SDK ${packageJson.version}`);
