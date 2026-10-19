import test from "node:test";
import assert from "node:assert/strict";
import { buildTwilioActivationChecklist } from "../src/calls/twilioActivation.js";

test("Twilio activation checklist stays blocked until durable and external gates are complete", () => {
  const report = buildTwilioActivationChecklist({
    VOICE_CALL_PROVIDER: "twilio",
    TWILIO_VOICE_ENABLED: "false",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "token",
    TWILIO_CALLER_ID: "+15551234567",
    TWILIO_WEBHOOK_BASE_URL: "https://chusky.example",
    TWILIO_MEDIA_STREAM_URL: "wss://voice.example/twilio/stream",
    CHUSKY_VOICE_STREAM_AUTHORIZE_URL: "https://chusky.example/internal/twilio/stream-authorize",
    TWILIO_MEDIA_BRIDGE_SECRET: "secret",
    REDIS_URL: "redis://example",
    DURABLE_STATE_ENABLED: "true",
    DURABLE_STATE_DATABASE_URL: "postgres://pooled",
    DURABLE_STATE_MIGRATION_DATABASE_URL: "postgres://direct",
    TWILIO_CUSTOMER_BILLING_READY: "false",
    TWILIO_REGULATORY_READY: "false",
  }, 123);

  assert.equal(report.status, "blocked");
  assert.equal(report.generatedAt, 123);
  assert.equal(report.checks.find((check) => check.id === "migration_0020")?.status, "manual");
  assert.equal(report.checks.find((check) => check.id === "voice_canary")?.status, "manual");
  assert.equal(report.current.numberManagementEnabled, false);
  assert.ok(report.protectedSwitches.some((item) => item.variable === "TWILIO_NUMBER_MANAGEMENT_ENABLED"));
});

test("Twilio activation checklist never exposes credentials and stays pending on manual gates", () => {
  const report = buildTwilioActivationChecklist({
    VOICE_CALL_PROVIDER: "twilio",
    TWILIO_VOICE_ENABLED: "true",
    TWILIO_INBOUND_ENABLED: "true",
    TWILIO_SUBACCOUNT_MANAGEMENT_ENABLED: "true",
    TWILIO_NUMBER_MANAGEMENT_ENABLED: "true",
    TWILIO_CUSTOMER_BILLING_READY: "true",
    TWILIO_REGULATORY_READY: "true",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "secret-token",
    TWILIO_CALLER_ID: "+15551234567",
    TWILIO_WEBHOOK_BASE_URL: "https://chusky.example",
    TWILIO_MEDIA_STREAM_URL: "wss://voice.example/twilio/stream",
    CHUSKY_VOICE_STREAM_AUTHORIZE_URL: "https://chusky.example/internal/twilio/stream-authorize",
    TWILIO_MEDIA_BRIDGE_SECRET: "secret",
    REDIS_URL: "redis://example",
    DURABLE_STATE_ENABLED: "true",
    DURABLE_STATE_DATABASE_URL: "postgres://pooled",
    DURABLE_STATE_MIGRATION_DATABASE_URL: "postgres://direct",
  });

  assert.equal(report.status, "pending");
  assert.equal(JSON.stringify(report).includes("secret-token"), false);
  assert.equal(JSON.stringify(report).includes("postgres://pooled"), false);
  assert.equal(report.checks.find((check) => check.id === "migration_0020")?.status, "manual");
});
