import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(skillDir, "..", "..", "..");
const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
const tools = await readFile(path.join(root, "src", "agentTools.ts"), "utf8");
const browser = await readFile(path.join(root, "e2b", "browser-template", "browser-agent.mjs"), "utf8");
const requiredSections = ["Universal form-completion procedure", "Live view and human takeover", "Recovery rules", "Completion contract"];
const requiredTools = ["CHUCK_BROWSER_PLAN", "CHUCK_BROWSER_OBSERVE", "CHUCK_BROWSER_ACT", "CHUCK_BROWSER_VERIFY", "CHUCK_BROWSER_HANDOFF_RESUME"];
const missing = [
  ...requiredSections.filter((item) => !skill.includes(item)).map((item) => `skill section: ${item}`),
  ...requiredTools.filter((item) => !tools.includes(item)).map((item) => `tool: ${item}`),
  ...["/health", "observationId", "pageGeneration", "challengeFor"].filter((item) => !browser.includes(item)).map((item) => `browser contract: ${item}`),
];
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: { skillSections: requiredSections.length, tools: requiredTools.length, browserContracts: 4 } }));
}
