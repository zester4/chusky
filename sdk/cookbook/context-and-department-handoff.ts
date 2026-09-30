import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const customerId = process.env.CUSTOMER_ID ?? "customer_123";
const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? customerId,
});

await chusky.context.save(
  {
    scope: "customer",
    scopeId: customerId,
    kind: "preference",
    key: "renewal_window",
    value: "Customer prefers renewal discussions in October.",
    source: "crm",
    confidence: 0.9,
    sensitivity: "normal",
  },
  { idempotencyKey: "cookbook-context-renewal-" + customerId },
);

const context = await chusky.context.list({
  scope: "customer",
  scopeId: customerId,
  purpose: "renewal",
});

const packet = await chusky.departments.handoff(
  "customer-success",
  {
    objective: "Prepare a renewal risk review for the account team.",
    inputs: { customerId },
    constraints: ["Use verified CRM facts only."],
    evidenceRequired: ["account health source", "open risk owner"],
    approvalBoundary: "Draft only; do not contact the customer.",
  },
  { idempotencyKey: "cookbook-renewal-handoff-" + customerId },
);

console.log({
  contextNodes: context.data.length,
  handoffId: packet.id,
  status: packet.status,
});
