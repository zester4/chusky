/**
 * Live Jev routing smoke test against the installed skill catalogue and,
 * optionally, a real Composio toolkit catalogue.
 *
 *   JEV_MODE=enforce npm run jev:live-smoke
 *   JEV_MODE=enforce npm run jev:live-smoke -- --toolkit gmail "Send Ama the pricing email"
 *   (--toolkit marks that app as connected; every other catalogue app is routed as unconnected)
 *
 * Prints routing decisions (identifiers and probabilities only) so thresholds
 * can be tuned before switching production to enforce.
 */
import { Composio } from "@composio/core";
import { config } from "../src/config.js";
import { jevClient } from "../src/decisions/jev.js";
import { computeJevSkillRoute } from "../src/decisions/skillRouter.js";
import { computeJevComposioDecision, toComposioAction, toComposioToolkitInfo, type ComposioAction, type ComposioToolkitInfo } from "../src/decisions/composioRouter.js";
import { computeTregTurnRoute } from "../src/decisions/tregRouter.js";

const args = process.argv.slice(2);
const toolkitIndex = args.indexOf("--toolkit");
const toolkit = toolkitIndex >= 0 ? args[toolkitIndex + 1] : undefined;
const prompts = args.filter((_, index) => index !== toolkitIndex && index !== toolkitIndex + 1);
const samples = prompts.length ? prompts : [
  "Build a waitlist landing page for our clinic app and make sure it ranks on Google",
  "Chase every overdue Stripe invoice from last month and draft polite reminders",
  "Find the work email of the head of operations at Hubtel",
  "Negotiate a better renewal price with our SaaS vendor",
  "hey, how are you?",
];

const client = jevClient();
console.log(`Jev model: ${client.modelId} via ${config.jevProvider}`);
const composio = toolkit ? new Composio({ apiKey: config.composioApiKey }) : undefined;
const listActions = async (slug: string): Promise<ComposioAction[]> => {
  const rows = await (composio as any).tools.getRawComposioTools({ toolkits: [slug], limit: 500 }) as unknown[];
  return rows.map((row) => toComposioAction(row, slug)).filter((row): row is ComposioAction => Boolean(row));
};

async function main(): Promise<void> {
const listToolkits = async (): Promise<ComposioToolkitInfo[]> => {
  const rows = await (composio as any).toolkits.get({ sortBy: "usage", limit: config.jevComposioCatalogLimit }) as unknown;
  const items = Array.isArray(rows) ? rows : ((rows as { items?: unknown[] })?.items ?? []);
  return items.map(toComposioToolkitInfo).filter((row): row is ComposioToolkitInfo => Boolean(row));
};

for (const prompt of samples) {
  const started = Date.now();
  const [skills, treg, composioDecision] = await Promise.all([
    computeJevSkillRoute(prompt, { client }),
    computeTregTurnRoute(prompt, { client }).catch((error) => ({ error: String(error) })),
    toolkit ? computeJevComposioDecision(prompt, { accounts: [{ toolkit, status: "ACTIVE" }], listActions, listToolkits, client }) : Promise.resolve(undefined),
  ]);
  console.log(JSON.stringify({
    prompt,
    wallMs: Date.now() - started,
    skills: { primary: skills.binding.primary, supporting: skills.binding.supporting, ranked: skills.ranked?.slice(0, 5), verified: skills.verified, telemetry: skills.telemetry },
    treg,
    ...(composioDecision ? { composio: { toolkits: composioDecision.toolkits, unconnected: composioDecision.unconnectedToolkits, actions: composioDecision.actions.map((action) => ({ id: action.id, p: action.probability, verified: action.verified })), direct: composioDecision.directTools.length, telemetry: composioDecision.telemetry } } : {}),
  }, null, 2));
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
