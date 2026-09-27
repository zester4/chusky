import { config } from "../src/config.js";
import { TregGateway } from "../src/treg/gateway.js";
import { TregSpendGuard } from "../src/treg/spend.js";
import { getTregSpend, initStore, saveTregReceipt, saveTregSpend } from "../src/store.js";

type Options = {
  domain: string;
  company?: string;
  userId: number;
  realCall: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    domain: "airmasters.net",
    company: "Air Masters of Tampa Bay",
    userId: 1,
    realCall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--domain") options.domain = String(argv[++index] ?? "").trim();
    else if (arg === "--company") options.company = String(argv[++index] ?? "").trim() || undefined;
    else if (arg === "--user-id") options.userId = Number(argv[++index] ?? "");
    else if (arg === "--real-call") options.realCall = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec -- tsx scripts/treg-live-smoke.ts [options]");
      console.log("  --domain <domain>       Company domain (default: airmasters.net)");
      console.log("  --company <name>        Company name");
      console.log("  --user-id <id>          Owner id for the local spend receipt (default: 1)");
      console.log("  --real-call             Execute one provider call; otherwise discovery only");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.domain || !/^[a-z0-9.-]+$/i.test(options.domain)) throw new Error("--domain must be a hostname");
  if (!Number.isSafeInteger(options.userId) || options.userId < 0) throw new Error("--user-id must be a non-negative integer");
  return options;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/TREG_TOKEN=[^\s]+/gi, "TREG_TOKEN=[redacted]").slice(0, 1000);
}

function summarizeProviderResult(value: unknown): Record<string, unknown> {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const output = root.output && typeof root.output === "object" && !Array.isArray(root.output)
    ? root.output as Record<string, unknown>
    : root;
  const fields = ["name", "domain", "industry", "employees", "founded", "location", "linkedin_url", "description"];
  return Object.fromEntries(fields.filter((field) => output[field] !== undefined).map((field) => [field, output[field]]));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!config.tregEnabled) throw new Error("Treg is disabled. Set TREG_ENABLED=true in .env.");
  if (!config.tregToken && Object.keys(config.tregOrganizationTokens).length === 0) throw new Error("No Treg token is configured. Set TREG_TOKEN in .env.");

  await initStore({ memoryOnly: true });
  const spend = new TregSpendGuard({ getSnap: getTregSpend, saveSnap: saveTregSpend });
  const gateway = new TregGateway({ spend, recordReceipt: saveTregReceipt });

  console.log(JSON.stringify({
    test: "treg-live-smoke",
    baseUrl: config.tregBaseUrl,
    tregEnabled: config.tregEnabled,
    tokenConfigured: Boolean(config.tregToken || Object.keys(config.tregOrganizationTokens).length),
    target: { domain: options.domain, company: options.company },
    mode: options.realCall ? "discovery-and-provider-call" : "catalog-discovery-only",
  }, null, 2));

  const queries = [
    "company enrichment by domain",
    "company profile industry employees website",
    "business domain lookup",
  ];
  const hits = [];
  for (const query of queries) {
    const found = await gateway.search(query, 10);
    console.log(JSON.stringify({ query, hitCount: found.length, hits: found }, null, 2));
    hits.push(...found);
    if (found.some((hit) => hit.category === "enrichment_company")) break;
  }

  const uniqueHits = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
  const candidates = uniqueHits.filter((hit) =>
    !hit.requiresOwnAccount &&
    !hit.requiresByok &&
    (hit.category === "enrichment_company" || /company|companies|firmographic|domain/i.test(`${hit.id} ${hit.title}`)),
  );
  const inspected = [];
  for (const candidate of candidates.slice(0, 8)) {
    try {
      inspected.push(await gateway.getEndpoint(candidate.id));
    } catch (error) {
      console.log(JSON.stringify({ endpoint: candidate.id, inspection: "failed", error: safeError(error) }, null, 2));
    }
  }
  const companyHits = inspected.filter((hit) =>
    !hit.requiresOwnAccount &&
    !hit.requiresByok &&
    hit.priceUsd !== undefined &&
    !/bulk|status|jobs|list/i.test(`${hit.id} ${hit.title}`),
  );
  if (!options.realCall) {
    console.log(JSON.stringify({
      result: "discovery_complete",
      providerCallExecuted: false,
      companyEndpointCandidates: inspected,
      next: "Re-run with --real-call to execute one selected provider call.",
    }, null, 2));
    return;
  }

  const selected = companyHits.find((hit) => hit.priceUsd !== undefined && hit.priceUsd <= config.tregPerCallSoftCapUsd) ?? companyHits[0];
  if (!selected) {
    throw new Error(`No priced, non-bulk company-enrichment endpoint was returned. Inspected: ${JSON.stringify(inspected)}`);
  }

  const result = await gateway.call({
    userId: options.userId,
    endpointId: selected.id,
    method: "POST",
    body: { domain: options.domain, company: options.company },
    estimateUsd: selected.priceUsd,
  });

  console.log(JSON.stringify({
    result: "provider_call_complete",
    endpoint: selected,
    providerResult: summarizeProviderResult(result.result),
    receipt: result.receipt,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "failed", error: safeError(error) }, null, 2));
  process.exitCode = 1;
});
