import path from "node:path";
import { writeAgentUpgrade } from "../src/upgradeNotice.js";

function values(flag: string): string[] {
  const args = process.argv.slice(2);
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1]) found.push(args[++index]);
  return found;
}

const version = values("--version")[0];
const title = values("--title")[0] ?? "Chusky has been upgraded";
const bullets = values("--bullet");
if (!version || !bullets.length) {
  console.error("Usage: npm run agent:upgrade -- --version 3.1.0 --bullet \"Change one\" [--bullet \"Change two\"] [--bullet \"Change three\"]");
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
