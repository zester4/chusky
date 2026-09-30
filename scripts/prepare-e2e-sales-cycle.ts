import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Options = {
  runId: string;
  target: string;
  externalActionsAuthorized: boolean;
  gmailAlias: string;
  hubspotAlias: string;
  salesInboxEmail: string;
  buyerEmail: string;
};

const BENCHMARK_FILES = [
  "README.md",
  "commercial-policy.md",
  "company-profile.md",
  "prompt.md",
  "scenario.md",
  "scorecard.md",
] as const;

function argumentMap(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) throw new Error(`Unexpected argument: ${value ?? ""}`);
    const key = value.slice(2);
    if (!key) throw new Error("Arguments must have a name.");
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return values;
}

function stringOption(values: Map<string, string | true>, name: string, fallback = ""): string {
  const value = values.get(name);
  if (value === true) throw new Error(`--${name} requires a value.`);
  return typeof value === "string" ? value.trim() : fallback;
}

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value);
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function booleanOption(values: Map<string, string | true>, ...names: string[]): boolean {
  for (const name of names) {
    const value = values.get(name);
    if (value === true) return true;
    if (typeof value === "string") return value.trim().toLowerCase() === "true";
  }
  return false;
}

function parseOptions(argv: string[]): Options {
  const values = argumentMap(argv);
  const runId = stringOption(values, "run-id", `e2e-sales-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`);
  if (!validRunId(runId)) throw new Error("--run-id must be 3-80 characters using letters, numbers, '.', '_' or '-'.");
  const target = path.resolve(process.cwd(), stringOption(values, "target", "workspace/e2e-sales-cycle"));
  const externalActionsAuthorized = booleanOption(values, "external-actions-authorized", "sandbox-confirmed");
  const salesInboxEmail = stringOption(values, "sales-inbox-email");
  const buyerEmail = stringOption(values, "buyer-email");
  for (const [name, email] of [["sales-inbox-email", salesInboxEmail], ["buyer-email", buyerEmail]] as const) {
    if (email && !validEmail(email)) throw new Error(`--${name} must be a valid email address.`);
  }
  return {
    runId,
    target,
    externalActionsAuthorized,
    gmailAlias: stringOption(values, "gmail-alias"),
    hubspotAlias: stringOption(values, "hubspot-alias"),
    salesInboxEmail,
    buyerEmail,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const source = path.resolve(process.cwd(), "benchmarks/e2e-sales-cycle");
  await mkdir(options.target, { recursive: true });
  for (const file of BENCHMARK_FILES) await copyFile(path.join(source, file), path.join(options.target, file));
  const config = {
    scenarioVersion: "e2e-sales-cycle-v3",
    runId: options.runId,
    externalActionsAuthorized: options.externalActionsAuthorized,
    ...(options.gmailAlias || options.hubspotAlias ? {
      connectedAccountHints: {
        ...(options.gmailAlias ? { gmail: options.gmailAlias } : {}),
        ...(options.hubspotAlias ? { hubspot: options.hubspotAlias } : {}),
      },
    } : {}),
    salesInboxEmail: options.salesInboxEmail,
    buyerEmail: options.buyerEmail,
  };
  await writeFile(path.join(options.target, "run-config.json"), `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Prepared ${options.target}`);
  console.log(`Run ID: ${options.runId}`);
  console.log("Attach README.md, run-config.json, company-profile.md, commercial-policy.md, and scenario.md to one dashboard message.");
  if (options.externalActionsAuthorized) {
    console.log("externalActionsAuthorized=true: provider access is enabled after live account discovery. Confirm the email addresses before sending the prompt.");
  } else {
    console.log("Copy the full text of prompt.md into that message, then leave externalActionsAuthorized false to test the connection pause or set it true after confirming the intended accounts and recipients.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not prepare the benchmark workspace.");
  process.exitCode = 1;
});
