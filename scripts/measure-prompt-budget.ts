import fs from "node:fs";
import { config } from "../src/config.js";
import { composeSystemPrompt } from "../src/prompt.js";
import { modelFacingChuckTools } from "../src/agentTools.js";
import { nativeToolManifest } from "../src/decisions/nativeToolRouter.js";
import { AUTONOMY_OPERATING_KERNEL } from "../src/autonomy/operatingLoop.js";
import { SHOPPING_AGENT_PLAYBOOK } from "../src/shopping/shopping.js";

const tok = (chars: number) => Math.round(chars / 3.6);
const row = (name: string, chars: number) => console.log(name.padEnd(36), String(tok(chars)).padStart(7), "tokens");

const agentSource = fs.readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
const meeting = agentSource.match(/const MEETING_MISSION_PLAYBOOK = `([\s\S]*?)`;/)?.[1] ?? "";
const system = composeSystemPrompt({ customizablePrompt: config.chuckSystemPrompt, mandatorySections: [AUTONOMY_OPERATING_KERNEL, SHOPPING_AGENT_PLAYBOOK, meeting] });
row("customizable system prompt", config.chuckSystemPrompt.length);
row("static system prompt (composed)", system.length);

const sizeBySlug = new Map<string, number>(modelFacingChuckTools.map((t: any) => [String(t.function?.name).toUpperCase(), JSON.stringify(t).length]));
const total = [...sizeBySlug.values()].reduce((a, b) => a + b, 0);
row(`native tools (${sizeBySlug.size})`, total);

const bundles: Record<string, { n: number; chars: number }> = {};
let core = 0;
for (const d of nativeToolManifest) {
  const chars = sizeBySlug.get(d.slug) ?? 0;
  (bundles[d.bundle] ??= { n: 0, chars: 0 }).n++; bundles[d.bundle].chars += chars;
  if (d.alwaysAvailable) core += chars;
}
row("  core (alwaysAvailable)", core);
for (const [name, v] of Object.entries(bundles).sort((a, b) => b[1].chars - a[1].chars)) row(`  bundle ${name} (${v.n})`, v.chars);
console.log("\nlargest tool schemas:", [...sizeBySlug].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n}=${tok(c)}t`).join(", "));
console.log("static floor per request (system + all native tools):", tok(system.length + total), "tokens");