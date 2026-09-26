import { runStagingWebhookSmoke } from "../src/reliability/providerWebhookSmoke.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

async function main(): Promise<void> {
  if (process.env.CHUSKY_PROVIDER_SMOKE_TARGET_STAGE !== "staging") {
    throw new Error("Set CHUSKY_PROVIDER_SMOKE_TARGET_STAGE=staging; this command refuses other targets.");
  }
  const report = await runStagingWebhookSmoke({
    targetStage: "staging",
    baseUrl: required("CHUSKY_PROVIDER_SMOKE_BASE_URL"),
    allowedOrigins: required("CHUSKY_PROVIDER_SMOKE_ALLOWED_ORIGINS").split(",").map((origin) => origin.trim()).filter(Boolean),
    slackSigningSecret: optional("SLACK_SIGNING_SECRET"),
    whatsappVerifyToken: optional("WHATSAPP_VERIFY_TOKEN"),
    whatsappAppSecret: optional("WHATSAPP_APP_SECRET"),
    sendblueWebhookSecret: optional("SENDBLUE_WEBHOOK_SECRET"),
    twilioAuthToken: optional("TWILIO_AUTH_TOKEN"),
    twilioStatusCallbackUrl: optional("TWILIO_SMS_STATUS_CALLBACK_URL"),
    xchatConsumerSecret: optional("X_CONSUMER_SECRET"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("Note: synthetic signed staging probes only; no provider message, agent turn, media path, full proof, or readiness update was performed.\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown provider webhook smoke failure.";
  process.stderr.write(`Provider webhook smoke failed: ${message}\n`);
  process.exitCode = 1;
});
