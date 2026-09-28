import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools } from "../src/agentTools.js";
import { requiresToolApproval } from "../src/policy.js";
import { isSharedChannelToolDenied } from "../src/sharedChannelPolicy.js";
import { getLinkSpendRequest, initStore, listLinkSpendRequests, saveLinkSpendRequest } from "../src/store.js";
import { safeProviderSpend, validateSpendArgs } from "../src/link/agentWallet.js";

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
    "CHUCK_LINK_WALLET_CONNECT",
    "CHUCK_LINK_WALLET_STATUS",
    "CHUCK_LINK_PAYMENT_METHODS",
    "CHUCK_LINK_CREATE_SPEND_REQUEST",
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
  assert.equal(requiresToolApproval("CHUCK_LINK_WALLET_CONNECT", {}, false, true), true);
  assert.equal(requiresToolApproval("CHUCK_LINK_WALLET_DISCONNECT", {}, false, true), true);
});

test("Link spend schema requires the owner-visible purchase context and exact amount", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_LINK_CREATE_SPEND_REQUEST");
  assert.ok(tool);
  const schema = tool.function.parameters as { required?: string[]; properties?: Record<string, { minimum?: number; minLength?: number; maximum?: number }> };
  assert.deepEqual(schema.required, ["merchantName", "merchantUrl", "amount", "currency", "context"]);
  assert.equal(schema.properties?.amount.minimum, 1);
  assert.equal(schema.properties?.amount.maximum, 50_000);
  assert.equal(schema.properties?.context.minLength, 100);
});
