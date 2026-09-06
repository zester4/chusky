import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const requested = process.argv[2] ?? "patch";
const packagePath = resolve("sdk", "package.json");
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
console.log(`Chusky SDK ${packageJson.version}`);
