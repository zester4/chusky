import path from "node:path";
import { getAgentUpgradePreset, writeAgentUpgrade } from "../src/upgradeNotice.js";

function values(flag: string): string[] {
  const args = process.argv.slice(2);
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1]) found.push(args[++index]);
  return found;
}

const version = values("--version")[0];
const title = values("--title")[0] ?? "Chusky has been upgraded";
const preset = values("--preset")[0];
const explicitBullets = values("--bullet");
if (preset && explicitBullets.length) {
  console.error("Choose either --preset or one or more --bullet values, not both.");
  process.exit(1);
}

let bullets = explicitBullets;
if (preset) {
  try {
    bullets = getAgentUpgradePreset(preset);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (!version || !bullets.length) {
  console.error("Usage: npm run agent:upgrade -- --version 3.3.0 --preset missions");
  console.error("   or: npm run agent:upgrade -- --version 3.1.0 --bullet \"Change one\" [--bullet \"Change two\"] [--bullet \"Change three\"]");
  process.exit(1);
}

async function main(): Promise<void> {
  const notice = await writeAgentUpgrade(path.resolve(process.cwd(), "agent-upgrade.json"), {
    id: `release-${version}`,
    version,
    title,
    bullets,
    createdAt: new Date().toISOString(),
  });
  console.log(`Wrote ${notice.id} with ${notice.bullets.length} upgrade bullets.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
