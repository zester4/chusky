import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools } from "../src/agentTools.js";
import { requiresToolApproval } from "../src/policy.js";
import { isSharedChannelToolDenied } from "../src/sharedChannelPolicy.js";
import { getLinkSpendRequest, initStore, listLinkSpendRequests, saveLinkSpendRequest } from "../src/store.js";
import { parsePaymentChallenge, safeProviderSpend, validateSpendArgs } from "../src/link/agentWallet.js";

const validSpend = {
  merchantName: "Triplo",
  merchantUrl: "https://triplo.com/checkout/room-123",
  amount: 18_000,
  currency: "usd",
  context: "Extend the owner's existing hotel reservation in New Orleans by one night at the displayed rate, with no upgrade, add-on, or second charge.",
};

test("Link spend validation requires an exact HTTPS merchant and bounded purchase context", () => {
  assert.deepEqual(validateSpendArgs(validSpend), {
    ...validSpend,
    currency: "USD",
  });
  assert.throws(() => validateSpendArgs({ ...validSpend, merchantUrl: "http://triplo.com/checkout" }), /HTTPS URL/);
  assert.throws(() => validateSpendArgs({ ...validSpend, amount: 50_001 }), /between 1 and/);
  assert.throws(() => validateSpendArgs({ ...validSpend, context: "buy it" }), /context must be/);
  assert.throws(() => validateSpendArgs({ ...validSpend, merchantUrl: "https://user:password@triplo.com/checkout" }), /without credentials/);
});

test("Link provider projections never expose card credentials or payment tokens", () => {
  const view = safeProviderSpend({
    id: "spend_123",
    status: "approved",
    approval_url: "https://link.com/approve/spend_123",
    credential_type: "card",
    card_brand: "visa",
    card_last4: "1234",
    link_transaction_id: "txn_123",
    card: { id: "card_123", brand: "visa", exp_month: 3, exp_year: 2030, number: "4111111111111111", cvc: "123" },
    link_pay_token: "lpt_secret",
    shared_payment_token: { id: "spt_secret" },
    payment_details: "sensitive",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  assert.deepEqual(view, {
    status: "approved",
    providerId: "spend_123",
    approvalUrl: "https://link.com/approve/spend_123",
    credentialType: "card",
    cardBrand: "visa",
    cardLast4: "1234",
    linkTransactionId: "txn_123",
  });
  assert.doesNotMatch(JSON.stringify(view), /4111111111111111|lpt_secret|spt_secret|sensitive/);
});

test("Link spend metadata is owner-scoped and bounded in durable storage", async () => {
  await initStore({ memoryOnly: true });
  const record = {
    id: "lsp_123456789012345678901234",
    userId: 910001,
    status: "pending_approval" as const,
    merchantName: "Triplo",
    merchantUrl: "https://triplo.com",
    amount: 18_000,
    currency: "USD",
    context: validSpend.context,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveLinkSpendRequest(record.userId, record);
  assert.equal((await getLinkSpendRequest(record.userId, record.id))?.id, record.id);
  assert.equal(await getLinkSpendRequest(910002, record.id), undefined);
  assert.equal((await listLinkSpendRequests(record.userId, 10)).length, 1);
});

test("Link wallet tools are owner-private and payment creation uses Link approval instead of a second Chusky prompt", () => {
  const names = [
    "CHUCK_LINK_CONNECT",
    "CHUCK_LINK_STATUS",
    "CHUCK_LINK_WALLET_CONNECT",
    "CHUCK_LINK_WALLET_STATUS",
    "CHUCK_LINK_PAYMENT_METHODS",
    "CHUCK_LINK_CREATE_SPEND_REQUEST",
    "CHUCK_LINK_INSPECT_CHECKOUT",
    "CHUCK_LINK_MPP_DISCOVER",
    "CHUCK_LINK_MPP_PAY",
    "CHUCK_LINK_UCP_SEARCH",
    "CHUCK_LINK_UCP_CREATE_CHECKOUT",
    "CHUCK_LINK_UCP_COMPLETE_CHECKOUT",
    "CHUCK_LINK_CONFIRM_ORDER",
    "CHUCK_LINK_WAIT_FOR_APPROVAL",
    "CHUCK_LINK_EXECUTE_PAYMENT",
    "CHUCK_LINK_RECEIPT",
    "CHUCK_LINK_REPORT_OUTCOME",
    "CHUCK_LINK_SPEND_STATUS",
    "CHUCK_LINK_SPEND_LIST",
    "CHUCK_LINK_SPEND_CANCEL",
    "CHUCK_LINK_COMPLETE_CHECKOUT",
    "CHUCK_LINK_WALLET_DISCONNECT",
  ];
  for (const name of names) {
    assert.equal(isSharedChannelToolDenied(name), true, name);
    assert.ok(chuckTools.some((tool) => tool.function.name === name), name);
  }
  assert.equal(requiresToolApproval("CHUCK_LINK_CREATE_SPEND_REQUEST", {}, false, true), false);
  assert.equal(requiresToolApproval("CHUCK_LINK_WAIT_FOR_APPROVAL", {}, false, true), false);
  assert.equal(requiresToolApproval("CHUCK_LINK_EXECUTE_PAYMENT", {}, false, true), false);
  assert.equal(requiresToolApproval("CHUCK_LINK_RECEIPT", {}, false, true), false);
  assert.equal(requiresToolApproval("CHUCK_LINK_CONNECT", {}, false, true), true);
  assert.equal(requiresToolApproval("CHUCK_LINK_WALLET_CONNECT", {}, false, true), true);
  assert.equal(requiresToolApproval("CHUCK_LINK_WALLET_DISCONNECT", {}, false, true), true);
});

test("Link lifecycle schemas keep approval waiting bounded and expose verified checkout transports", () => {
  const wait = chuckTools.find((item) => item.function.name === "CHUCK_LINK_WAIT_FOR_APPROVAL");
  const execute = chuckTools.find((item) => item.function.name === "CHUCK_LINK_EXECUTE_PAYMENT");
  const receipt = chuckTools.find((item) => item.function.name === "CHUCK_LINK_RECEIPT");
  assert.ok(wait);
  assert.ok(execute);
  assert.ok(receipt);
  const waitSchema = wait.function.parameters as { properties?: Record<string, { maximum?: number; enum?: string[] }> };
  assert.equal(waitSchema.properties?.waitSeconds.maximum, 30);
  const executeSchema = execute.function.parameters as { properties?: Record<string, { enum?: string[] }> };
  assert.deepEqual(executeSchema.properties?.executionMethod.enum, ["browser", "link_pay_token"]);
  const receiptSchema = receipt.function.parameters as { required?: string[] };
  assert.deepEqual(receiptSchema.required, ["spendRequestId"]);
});

test("Link spend schema requires the owner-visible purchase context and exact amount", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_LINK_CREATE_SPEND_REQUEST");
  assert.ok(tool);
  const schema = tool.function.parameters as { required?: string[]; properties?: Record<string, { minimum?: number; minLength?: number; maximum?: number }> };
  assert.deepEqual(schema.required, ["amount", "currency", "context"]);
  assert.equal(schema.properties?.amount.minimum, 1);
  assert.equal(schema.properties?.amount.maximum, 50_000);
  assert.equal(schema.properties?.context.minLength, 100);
});

test("Link protocol validation binds LPT to a Stripe account and MPP to a network", () => {
  assert.equal(validateSpendArgs({ ...validSpend, executionMethod: "link_pay_token", merchantAccountId: "acct_12345" }).executionMethod, "link_pay_token");
  assert.equal(validateSpendArgs({ ...validSpend, credentialType: "shared_payment_token", networkId: "stripe_profile_123" }).credentialType, "shared_payment_token");
  assert.throws(() => validateSpendArgs({ ...validSpend, executionMethod: "link_pay_token" }), /merchantAccountId/);
  assert.throws(() => validateSpendArgs({ ...validSpend, credentialType: "shared_payment_token" }), /networkId/);
});

test("MPP Payment challenges parse only bounded protocol fields", () => {
  const request = Buffer.from(JSON.stringify({ methodDetails: { networkId: "stripe_profile_123" }, amount: 1800, currency: "usd" }), "utf8").toString("base64url");
  const challenge = parsePaymentChallenge(`Payment id="ch_123", realm="triplo.com", method="stripe", intent="purchase", request="${request}"`);
  assert.deepEqual(challenge.requestJson, { methodDetails: { networkId: "stripe_profile_123" }, amount: 1800, currency: "usd" });
  assert.throws(() => parsePaymentChallenge("Bearer token"), /Payment challenge/);
});

test("Link status projections preserve only safe step-up recovery metadata", () => {
  const view = safeProviderSpend({
    id: "spend_step_up",
    status: "requires_action",
    status_details: { requires_action: { failure_code: "identity_verification", next_action: { type: "identity_verification", resolution: "create_new_spend_request", display_message: "Do not trust this model-authored message", action_url: "https://link.com/verify", expires_at: 1_900_000_000_000 } } },
    card: { id: "card_secret", brand: "visa", exp_month: 1, exp_year: 2030, number: "4111111111111111", cvc: "123" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  assert.deepEqual(view.statusDetails, { requiresAction: { failureCode: "identity_verification", nextAction: { type: "identity_verification", resolution: "create_new_spend_request", actionUrl: "https://link.com/verify", expiresAt: 1_900_000_000_000 } } });
  assert.doesNotMatch(JSON.stringify(view), /Do not trust|4111111111111111|card_secret/);
});

test("Link spend schema lets LPT resolve merchant identity from the Stripe account", () => {
  const schema = chuckTools.find((item) => item.function.name === "CHUCK_LINK_CREATE_SPEND_REQUEST")?.function.parameters as { properties?: Record<string, unknown> };
  assert.ok(schema.properties?.merchantName);
  assert.ok(schema.properties?.merchantUrl);
  assert.deepEqual((schema as { required?: string[] }).required, ["amount", "currency", "context"]);
});
