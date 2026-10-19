import assert from "node:assert/strict";
import { test } from "node:test";
import { customerPriceForProviderCost, isTwilioVoiceBridgeConfigured, purchaseTwilioNumber, searchTwilioNumbers, twilioNumberCatalog } from "../src/calls/twilioNumbers.js";

const configured = {
  enabled: true,
  accountSid: "AC" + "a".repeat(32),
  authToken: "test-auth-token",
  webhookBaseUrl: "https://chusky.example.com",
};

test("customer number catalog exposes the initial US, Canada, and eight European markets", () => {
  const countries = twilioNumberCatalog();
  assert.equal(countries.length, 10);
  assert.deepEqual(countries.slice(0, 2).map((country) => country.code), ["US", "CA"]);
  assert.deepEqual(countries.slice(2).map((country) => country.code), ["GB", "DE", "FR", "BE", "AT", "IE", "NL", "PT"]);
  assert.equal(countries.find((country) => country.code === "US")?.regionLabel, "State");
});

test("number search rejects a country outside the customer allowlist before provider dispatch", async () => {
  await assert.rejects(
    searchTwilioNumbers({ countryCode: "GH" }, configured),
    /country is not available/i,
  );
});

test("number purchase rejects a selected country that does not match the number", async () => {
  await assert.rejects(
    purchaseTwilioNumber({ phoneNumber: "+447700900123", countryCode: "DE" }, configured),
    /selected country does not match/i,
  );
});

test("number search bounds multi-area-code requests before provider dispatch", async () => {
  await assert.rejects(
    searchTwilioNumbers({ countryCode: "US", areaCodes: ["201", "202", "205", "206", "207", "208"] }, configured),
    /up to five area codes/i,
  );
  await assert.rejects(
    searchTwilioNumbers({ countryCode: "US", areaCodes: ["20A"] }, configured),
    /areaCodes must contain only digits/i,
  );
});

test("number pricing keeps the standard price below the threshold and hides over-cap inventory", () => {
  const policy = { standardPriceCents: 200, providerCostThresholdCents: 150, markupCents: 25, priceCapCents: 200 };
  assert.equal(customerPriceForProviderCost(115, policy), 200);
  assert.equal(customerPriceForProviderCost(160, policy), 185);
  assert.equal(customerPriceForProviderCost(200, policy), undefined);
});

test("tenant number sales require a complete Twilio voice bridge", () => {
  const base = {
    enabled: true,
    inboundEnabled: true,
    accountSid: configured.accountSid,
    authToken: configured.authToken,
    webhookBaseUrl: configured.webhookBaseUrl,
    mediaStreamUrl: "wss://voice.example.com/twilio-stream",
    mediaBridgeSecret: "bridge-secret",
  };
  assert.equal(isTwilioVoiceBridgeConfigured(base), true);
  assert.equal(isTwilioVoiceBridgeConfigured({ ...base, enabled: false }), false);
  assert.equal(isTwilioVoiceBridgeConfigured({ ...base, inboundEnabled: false }), false);
  assert.equal(isTwilioVoiceBridgeConfigured({ ...base, mediaStreamUrl: "https://voice.example.com/twilio-stream" }), false);
  assert.equal(isTwilioVoiceBridgeConfigured({ ...base, mediaBridgeSecret: "" }), false);
});
