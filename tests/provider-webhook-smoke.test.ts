import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { runStagingWebhookSmoke } from "../src/reliability/providerWebhookSmoke.js";

const completeConfig = {
  targetStage: "staging" as const,
  baseUrl: "https://chusky-staging.example.test",
  allowedOrigins: ["https://chusky-staging.example.test"],
  slackSigningSecret: "slack-test-secret",
  whatsappVerifyToken: "whatsapp-test-verify",
  whatsappAppSecret: "whatsapp-test-app-secret",
  sendblueWebhookSecret: "sendblue-test-secret",
  twilioAuthToken: "twilio-test-auth-token",
  xchatConsumerSecret: "xchat-test-consumer-secret",
};

test("staging webhook smoke exercises only signed callbacks and never sends or certifies messages", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/slack/events") {
      const body = JSON.parse(String(init.body)) as { challenge: string };
      return Response.json({ challenge: body.challenge });
    }
    if (url.pathname === "/whatsapp/webhook" && init.method === "GET") return new Response(url.searchParams.get("hub.challenge"));
    if (url.pathname === "/xchat/webhook") return Response.json({ response_token: `sha256=${createHmac("sha256", completeConfig.xchatConsumerSecret).update(url.searchParams.get("crc_token") ?? "").digest("base64")}` });
    if (url.pathname === "/twilio/sms/status") return new Response("ok");
    return Response.json({ ok: true });
  };

  const report = await runStagingWebhookSmoke(completeConfig, fetchImpl);

  assert.deepEqual(report.results.map((result) => result.provider).sort(), ["sendblue", "slack", "twilio", "whatsapp", "xchat"]);
  assert.equal(report.outboundMessagesSent, 0);
  assert.equal(report.fullProviderProofCreated, false);
  assert.equal(report.readinessChanged, false);
  assert.ok(requests.every(({ url }) => url.origin === completeConfig.baseUrl));
  assert.ok(requests.every(({ url }) => !url.pathname.includes("provider-proof")));
  assert.ok(requests.every(({ url }) => !["slack.com", "graph.facebook.com", "api.sendblue.com", "api.twilio.com"].includes(url.hostname)));
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), ["/sendblue/status", "/slack/events", "/twilio/sms/status", "/whatsapp/webhook", "/whatsapp/webhook", "/xchat/webhook"].sort());
  assert.ok(requests.every(({ init }) => init.redirect === "manual"));
});

test("staging webhook smoke rejects a target outside the exact HTTPS allowlist before network access", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => { called = true; return new Response("unexpected"); };

  await assert.rejects(runStagingWebhookSmoke({ ...completeConfig, baseUrl: "https://chusky.up.railway.app" }, fetchImpl), /not in the staging origin allowlist/);
  assert.equal(called, false);
});

test("staging webhook smoke rejects a Twilio callback URL outside the staging status route before network access", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => { called = true; return new Response("unexpected"); };

  await assert.rejects(
    runStagingWebhookSmoke({ ...completeConfig, twilioStatusCallbackUrl: "https://chusky.up.railway.app/twilio/sms/status" }, fetchImpl),
    /Twilio status callback URL must be the staging/,
  );
  assert.equal(called, false);
});
