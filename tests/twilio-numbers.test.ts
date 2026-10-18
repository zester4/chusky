import assert from "node:assert/strict";
import { test } from "node:test";
import { purchaseTwilioNumber, searchTwilioNumbers, twilioNumberCatalog } from "../src/calls/twilioNumbers.js";

const configured = {
  enabled: true,
  accountSid: "AC" + "a".repeat(32),
  authToken: "test-auth-token",
  webhookBaseUrl: "https://chusky.example.com",
};

test("customer number catalog exposes the initial US, Canada, and ten European markets", () => {
  const countries = twilioNumberCatalog();
  assert.equal(countries.length, 12);
  assert.deepEqual(countries.slice(0, 2).map((country) => country.code), ["US", "CA"]);
  assert.deepEqual(countries.slice(2).map((country) => country.code), ["GB", "DE", "FR", "IE", "NL", "ES", "IT", "SE", "NO", "DK"]);
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
