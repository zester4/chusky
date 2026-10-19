export type TwilioActivationStatus = "complete" | "pending" | "blocked" | "manual";

export interface TwilioActivationCheck {
  id: string;
  title: string;
  status: TwilioActivationStatus;
  required: boolean;
  detail: string;
  variables?: string[];
}

export interface TwilioActivationChecklist {
  status: "ready" | "pending" | "blocked";
  generatedAt: number;
  current: {
    provider: string;
    voiceEnabled: boolean;
    inboundEnabled: boolean;
    subaccountManagementEnabled: boolean;
    numberManagementEnabled: boolean;
    customerBillingReady: boolean;
    regulatoryReady: boolean;
  };
  checks: TwilioActivationCheck[];
  activationOrder: string[];
  protectedSwitches: Array<{
    variable: string;
    keep: "false";
    reason: string;
  }>;
}

type ActivationEnv = Record<string, string | undefined>;

const present = (env: ActivationEnv, key: string): boolean => Boolean(env[key]?.trim());
const enabled = (env: ActivationEnv, key: string): boolean => env[key]?.trim().toLowerCase() === "true";
const https = (env: ActivationEnv, key: string): boolean => /^https:\/\//i.test(env[key]?.trim() ?? "");
const wss = (env: ActivationEnv, key: string): boolean => /^wss:\/\//i.test(env[key]?.trim() ?? "");

/**
 * A redacted, operator-facing activation plan. It intentionally reports only
 * booleans and variable names; provider credentials and URLs are never
 * returned by this checklist.
 */
export function buildTwilioActivationChecklist(env: ActivationEnv = process.env, now = Date.now()): TwilioActivationChecklist {
  const provider = env.VOICE_CALL_PROVIDER?.trim().toLowerCase() || "twilio";
  const voiceEnabled = enabled(env, "TWILIO_VOICE_ENABLED");
  const inboundEnabled = enabled(env, "TWILIO_INBOUND_ENABLED");
  const subaccountManagementEnabled = enabled(env, "TWILIO_SUBACCOUNT_MANAGEMENT_ENABLED");
  const numberManagementEnabled = enabled(env, "TWILIO_NUMBER_MANAGEMENT_ENABLED");
  const customerBillingReady = enabled(env, "TWILIO_CUSTOMER_BILLING_READY");
  const regulatoryReady = enabled(env, "TWILIO_REGULATORY_READY");

  const checks: TwilioActivationCheck[] = [
    {
      id: "provider_pin",
      title: "Provider is explicitly pinned to Twilio",
      status: provider === "twilio" ? "complete" : "blocked",
      required: true,
      detail: provider === "twilio" ? "VOICE_CALL_PROVIDER is set to twilio." : "Set VOICE_CALL_PROVIDER=twilio before enabling Twilio calling.",
      variables: ["VOICE_CALL_PROVIDER"],
    },
    {
      id: "parent_credentials",
      title: "Parent Twilio credentials are configured",
      status: present(env, "TWILIO_ACCOUNT_SID") && present(env, "TWILIO_AUTH_TOKEN") && present(env, "TWILIO_CALLER_ID") ? "complete" : "blocked",
      required: true,
      detail: "The parent account owns provider billing and must have a verified caller ID.",
      variables: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_CALLER_ID"],
    },
    {
      id: "bridge_endpoints",
      title: "Signed webhook and media bridge endpoints are configured",
      status: https(env, "TWILIO_WEBHOOK_BASE_URL") && wss(env, "TWILIO_MEDIA_STREAM_URL") ? "complete" : "blocked",
      required: true,
      detail: "Twilio callbacks require HTTPS and the media stream requires WSS.",
      variables: ["TWILIO_WEBHOOK_BASE_URL", "TWILIO_MEDIA_STREAM_URL"],
    },
    {
      id: "bridge_authorization",
      title: "Voice service points at the root stream authorization endpoint",
      status: https(env, "CHUSKY_VOICE_STREAM_AUTHORIZE_URL") && present(env, "TWILIO_MEDIA_BRIDGE_SECRET") ? "complete" : "blocked",
      required: true,
      detail: "The same high-entropy bridge secret must be configured on the root and voice services.",
      variables: ["CHUSKY_VOICE_STREAM_AUTHORIZE_URL", "TWILIO_MEDIA_BRIDGE_SECRET"],
    },
    {
      id: "durable_runtime",
      title: "Redis and direct Neon durable-state configuration are present",
      status: present(env, "REDIS_URL") && enabled(env, "DURABLE_STATE_ENABLED") && present(env, "DURABLE_STATE_DATABASE_URL") && present(env, "DURABLE_STATE_MIGRATION_DATABASE_URL") ? "complete" : "blocked",
      required: true,
      detail: "Voice lifecycle and reconciliation must not fall back to process memory.",
      variables: ["REDIS_URL", "DURABLE_STATE_ENABLED", "DURABLE_STATE_DATABASE_URL", "DURABLE_STATE_MIGRATION_DATABASE_URL"],
    },
    {
      id: "migration_0020",
      title: "Production Neon migration 0020 has been applied and verified",
      status: "manual",
      required: true,
      detail: "Run the direct Neon migration command and verify the reconciliation table before activation.",
      variables: ["DURABLE_STATE_MIGRATION_DATABASE_URL"],
    },
    {
      id: "voice_canary",
      title: "Dedicated-number production canary has passed",
      status: "manual",
      required: true,
      detail: "Verify inbound, outbound, no-answer, busy, failed, voicemail, interruption, Composio, handoff, transcript/outcome persistence, duplicate webhook, Deepgram reconnect, and ambiguous-response behavior.",
    },
    {
      id: "load_test",
      title: "Distributed capacity and load test have passed",
      status: "manual",
      required: true,
      detail: "Run the bounded load test against the deployed root and bridge services and confirm the distributed active-call limit.",
      variables: ["TWILIO_VOICE_MAX_ACTIVE_CALLS", "VOICE_BRIDGE_MAX_ACTIVE_CALLS"],
    },
    {
      id: "voice_switch",
      title: "Twilio calling is enabled",
      status: voiceEnabled ? "complete" : "pending",
      required: true,
      detail: voiceEnabled ? "Twilio calling is enabled." : "Keep false until the migration, deployment, shared-secret, canary, and load checks pass.",
      variables: ["TWILIO_VOICE_ENABLED"],
    },
    {
      id: "inbound_switch",
      title: "Inbound calling is enabled",
      status: inboundEnabled ? "complete" : "pending",
      required: false,
      detail: "Enable only after a dedicated inbound number, route/profile, caller policy, and Twilio Voice URL are verified.",
      variables: ["TWILIO_INBOUND_ENABLED"],
    },
    {
      id: "billing_integration",
      title: "Customer billing and cancellation are externally verified",
      status: customerBillingReady ? "complete" : "blocked",
      required: true,
      detail: "This flag is an attestation only; it must remain false until real customer charging, renewal, release, refund, and failure paths are tested.",
      variables: ["TWILIO_CUSTOMER_BILLING_READY"],
    },
    {
      id: "regulatory_workflow",
      title: "Country-specific regulatory and emergency-address workflows are verified",
      status: regulatoryReady ? "complete" : "blocked",
      required: true,
      detail: "Verify Twilio regulatory bundles, identity/address requirements, emergency calling obligations, and failure handling for every enabled market.",
      variables: ["TWILIO_REGULATORY_READY"],
    },
    {
      id: "number_sales_switch",
      title: "Managed number sales are enabled",
      status: numberManagementEnabled ? "complete" : "pending",
      required: false,
      detail: "Enable last. It must remain false until subaccounts, billing, regulatory handling, release, and the customer canary are complete.",
      variables: ["TWILIO_SUBACCOUNT_MANAGEMENT_ENABLED", "TWILIO_NUMBER_MANAGEMENT_ENABLED"],
    },
  ];

  const requiredChecks = checks.filter((check) => check.required);
  const status = requiredChecks.some((check) => check.status === "blocked")
    ? "blocked"
    : requiredChecks.some((check) => check.status !== "complete")
      ? "pending"
      : "ready";

  return {
    status,
    generatedAt: now,
    current: {
      provider,
      voiceEnabled,
      inboundEnabled,
      subaccountManagementEnabled,
      numberManagementEnabled,
      customerBillingReady,
      regulatoryReady,
    },
    checks,
    activationOrder: [
      "Apply migration 0020 to production Neon using the direct connection.",
      "Deploy the root backend and chusky-voice from their main branches.",
      "Set the same TWILIO_MEDIA_BRIDGE_SECRET on both services.",
      "Set CHUSKY_VOICE_STREAM_AUTHORIZE_URL on chusky-voice.",
      "Keep billing and regulatory flags false until external verification.",
      "Run the real dedicated-number canary and distributed load test.",
      "Enable TWILIO_VOICE_ENABLED for controlled calling.",
      "Enable TWILIO_INBOUND_ENABLED only for a verified route.",
      "Enable subaccount and number management last, after billing/regulatory approval.",
    ],
    protectedSwitches: [
      { variable: "TWILIO_CUSTOMER_BILLING_READY", keep: "false", reason: "No customer number sales without verified billing and cancellation." },
      { variable: "TWILIO_REGULATORY_READY", keep: "false", reason: "No number sales without verified country and emergency-address workflows." },
      { variable: "TWILIO_SUBACCOUNT_MANAGEMENT_ENABLED", keep: "false", reason: "Do not provision tenant provider accounts before the canary passes." },
      { variable: "TWILIO_NUMBER_MANAGEMENT_ENABLED", keep: "false", reason: "Do not expose billable Buy/Release actions before the final gate." },
    ],
  };
}
