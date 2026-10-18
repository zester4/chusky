import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, beforeEach } from "node:test";
import { encryptCredential } from "../src/vault/crypto.js";
import {
  appendTwilioBillingEntry,
  getTwilioNumberOwnership,
  getTwilioSubaccountByUserId,
  initStore,
  listTwilioBillingEntries,
  saveTwilioNumberOwnership,
  saveTwilioSubaccount,
  type TwilioSubaccountRecord,
} from "../src/store.js";

const key = randomBytes(32).toString("base64url");

beforeEach(async () => {
  await initStore({ memoryOnly: true });
});

test("tenant Twilio credentials are stored as encrypted records with durable ownership and billing projections", async () => {
  const record: TwilioSubaccountRecord = {
    id: "twa_test_workspace_001",
    userId: 7906015891,
    twilioAccountSid: "AC" + "a".repeat(32),
    encryptedCredentials: encryptCredential({ accountSid: "AC" + "a".repeat(32), authToken: "secret-auth-token" }, key, "TWILIO_SUBACCOUNT_ENCRYPTION_KEY"),
    status: "active",
    friendlyName: "Test workspace",
    providerStatus: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  assert.equal(await saveTwilioSubaccount(record), true);
  assert.equal(await saveTwilioSubaccount({ ...record, friendlyName: "Updated workspace", updatedAt: Date.now() }), true);
  const stored = await getTwilioSubaccountByUserId(record.userId);
  assert.equal(stored?.friendlyName, "Updated workspace");
  assert.ok(stored?.encryptedCredentials);
  assert.equal(JSON.stringify(stored).includes("secret-auth-token"), false);

  const ownership = {
    id: "two_test_number_001",
    userId: record.userId,
    subaccountId: record.id,
    phoneNumber: "+14155550123",
    providerNumberId: "PN" + "b".repeat(32),
    status: "active" as const,
    currency: "USD" as const,
    customerPriceCents: 200,
    purchasedAt: Date.now(),
    updatedAt: Date.now(),
  };
  assert.equal(await saveTwilioNumberOwnership(ownership), true);
  assert.deepEqual(await getTwilioNumberOwnership(ownership.providerNumberId), ownership);
  await appendTwilioBillingEntry({ id: "twb_test_001", userId: record.userId, subaccountId: record.id, ownershipId: ownership.id, kind: "number_purchase", amountCents: 200, currency: "USD", status: "recorded", createdAt: Date.now() });
  await appendTwilioBillingEntry({ id: "twb_test_001", userId: record.userId, subaccountId: record.id, ownershipId: ownership.id, kind: "number_purchase", amountCents: 200, currency: "USD", status: "recorded", createdAt: Date.now() });
  assert.equal((await listTwilioBillingEntries(record.userId)).length, 1);
  assert.equal(await saveTwilioNumberOwnership({ ...ownership, providerNumberId: "PN" + "c".repeat(32) }), false);
});
