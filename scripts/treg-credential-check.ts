import { config } from "../src/config.js";
import { TregGateway } from "../src/treg/gateway.js";
import { TregSpendGuard } from "../src/treg/spend.js";

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

async function check(label: string, request: () => Promise<unknown>): Promise<boolean> {
  try {
    await request();
    console.log(`[PASS] ${label}`);
    return true;
  } catch (error) {
    const status = httpStatus(error);
    console.error(`[FAIL] ${label}${status ? ` (HTTP ${status})` : ""}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Treg credential check (read-only; token and billing details are not printed)");
  if (!config.tregToken) {
    console.error("[FAIL] TREG_TOKEN is missing from the loaded environment.");
    process.exitCode = 1;
    return;
  }
  if (!config.tregEnabled) {
    console.error("[FAIL] Treg is disabled by configuration.");
    process.exitCode = 1;
    return;
  }

  const gateway = new TregGateway({
    // These two GET checks do not use the local spend ledger or create receipts.
    spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
    recordReceipt: async () => {},
  });

  const catalogOk = await check("Company-search catalog access", () => gateway.getEndpoint("treg.companies.search"));
  const billingOk = await check("Billing endpoint access", () => gateway.balance());

  if (catalogOk && billingOk) {
    console.log("Credential valid: Treg accepted it for both read-only checks.");
    return;
  }

  console.error("Credential validity was not confirmed by both checks.");
  process.exitCode = 1;
}

void main().catch(() => {
  console.error("Credential check failed due to a local setup or runtime error.");
  process.exitCode = 1;
});
