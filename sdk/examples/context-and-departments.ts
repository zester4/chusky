import { createClient } from "./_client.js";

const chusky = createClient();
const customerId = process.env.CHUSKY_USER_ID ?? "example-user";

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
  { idempotencyKey: `context-renewal-window-${customerId}` },
);

const context = await chusky.context.list({
  scope: "customer",
  scopeId: customerId,
  purpose: "renewal",
});

const catalog = await chusky.departments.catalog();
console.log("Available departments:", catalog.data.map((item) => item.slug));

const packet = await chusky.departments.handoff(
  "customer-success",
  {
    objective: "Prepare a renewal risk review for the account team.",
    inputs: { customerId },
    constraints: ["Use verified CRM facts only."],
    evidenceRequired: ["account health source", "open risk owner"],
    approvalBoundary: "Draft only; do not contact the customer.",
  },
  { idempotencyKey: `handoff-renewal-risk-${customerId}` },
);

console.log({ contextNodes: context.data.length, handoffId: packet.id, status: packet.status });
