import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface StagingWebhookSmokeConfig {
  targetStage: "staging";
  baseUrl: string;
  allowedOrigins: string[];
  slackSigningSecret?: string;
  whatsappVerifyToken?: string;
  whatsappAppSecret?: string;
  sendblueWebhookSecret?: string;
  twilioAuthToken?: string;
  twilioStatusCallbackUrl?: string;
  xchatConsumerSecret?: string;
}

export interface StagingWebhookSmokeReport {
  scope: "staging_webhook_boundaries_only";
  results: Array<{ provider: "slack" | "whatsapp" | "sendblue" | "twilio" | "xchat"; checks: string[]; status: "passed" }>;
  outboundMessagesSent: 0;
  fullProviderProofCreated: false;
  readinessChanged: false;
}

type Provider = StagingWebhookSmokeReport["results"][number]["provider"];
type Fetcher = typeof fetch;

function hmac(algorithm: "sha1" | "sha256", key: string, value: string, encoding: "hex" | "base64"): string {
  return createHmac(algorithm, key).update(value).digest(encoding);
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateStagingOrigin(config: StagingWebhookSmokeConfig): URL {
  if (config.targetStage !== "staging") throw new Error("Provider webhook smoke can only target staging.");
  let target: URL;
  try { target = new URL(config.baseUrl); }
  catch { throw new Error("Provider webhook smoke requires a valid staging HTTPS origin."); }
  const normalizedAllowlist = new Set(config.allowedOrigins.map((origin) => {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return "";
      return parsed.origin;
    } catch { return ""; }
  }).filter(Boolean));
  if (target.protocol !== "https:" || target.pathname !== "/" || target.search || target.hash || target.username || target.password || !normalizedAllowlist.has(target.origin)) {
    throw new Error("Provider webhook smoke target is not in the staging origin allowlist.");
  }
  return target;
}

function configuredProviders(config: StagingWebhookSmokeConfig): Provider[] {
  const configured: Provider[] = [];
  if (config.slackSigningSecret) configured.push("slack");
  if (config.whatsappVerifyToken || config.whatsappAppSecret) {
    if (!config.whatsappVerifyToken || !config.whatsappAppSecret) throw new Error("WhatsApp webhook smoke requires both its verification token and app secret.");
    configured.push("whatsapp");
  }
  if (config.sendblueWebhookSecret) configured.push("sendblue");
  if (config.twilioAuthToken) configured.push("twilio");
  if (config.xchatConsumerSecret) configured.push("xchat");
  if (!configured.length) throw new Error("Configure at least one staging webhook secret to run provider smoke checks.");
  return configured;
}

function twilioCallbackUrl(config: StagingWebhookSmokeConfig, base: URL): string {
  const callback = new URL(config.twilioStatusCallbackUrl ?? "/twilio/sms/status", base);
  if (callback.protocol !== "https:" || callback.origin !== base.origin || callback.pathname !== "/twilio/sms/status" || callback.search || callback.hash || callback.username || callback.password) {
    throw new Error("Twilio status callback URL must be the staging /twilio/sms/status endpoint on the allowlisted origin.");
  }
  return callback.toString();
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new Error("Staging webhook smoke response exceeded its size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function runStagingWebhookSmoke(
  config: StagingWebhookSmokeConfig,
  fetchImpl: Fetcher = fetch,
): Promise<StagingWebhookSmokeReport> {
  const base = validateStagingOrigin(config);
  const providers = configuredProviders(config);
  const twilioUrl = providers.includes("twilio") ? twilioCallbackUrl(config, base) : undefined;
  const results: StagingWebhookSmokeReport["results"] = [];
  const request = async (provider: Provider, path: string, init: RequestInit): Promise<Response> => {
    const url = new URL(path, base);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error(`${provider} staging webhook did not respond.`);
    }
    if (response.status >= 300 && response.status < 400) throw new Error(`${provider} staging webhook redirected; redirects are not followed.`);
    return response;
  };
  const requireOk = (provider: Provider, response: Response): void => {
    if (!response.ok) throw new Error(`${provider} staging webhook returned HTTP ${response.status}.`);
  };

  for (const provider of providers) {
    if (provider === "slack") {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const challenge = `chusky-smoke-${randomUUID()}`;
      const body = JSON.stringify({ type: "url_verification", challenge });
      const signature = `v0=${hmac("sha256", config.slackSigningSecret!, `v0:${timestamp}:${body}`, "hex")}`;
      const response = await request(provider, "/slack/events", { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body });
      requireOk(provider, response);
      const payload = JSON.parse(await responseText(response)) as { challenge?: unknown };
      if (payload.challenge !== challenge) throw new Error("Slack staging webhook did not echo its URL-verification challenge.");
      results.push({ provider, checks: ["signed_url_verification"], status: "passed" });
      continue;
    }

    if (provider === "whatsapp") {
      const challenge = `chusky-smoke-${randomUUID()}`;
      const url = new URL("/whatsapp/webhook", base);
      url.search = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": config.whatsappVerifyToken!, "hub.challenge": challenge }).toString();
      const challengeResponse = await request(provider, `${url.pathname}${url.search}`, { method: "GET" });
      requireOk(provider, challengeResponse);
      if (await responseText(challengeResponse) !== challenge) throw new Error("WhatsApp staging webhook did not echo its verification challenge.");

      const statusBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "smoke", changes: [{ field: "messages", value: { statuses: [{ id: `wamid.smoke.${randomUUID()}`, status: "delivered" }] } }] }] });
      const signature = `sha256=${hmac("sha256", config.whatsappAppSecret!, statusBody, "hex")}`;
      const statusResponse = await request(provider, "/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: statusBody });
      requireOk(provider, statusResponse);
      results.push({ provider, checks: ["verification_challenge", "signed_status_callback"], status: "passed" });
      continue;
    }

    if (provider === "sendblue") {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ is_outbound: true, message_handle: `smoke-${randomUUID()}`, status: "delivered" });
      const signature = hmac("sha256", config.sendblueWebhookSecret!, `${timestamp}.${body}`, "hex");
      const response = await request(provider, "/sendblue/status", { method: "POST", headers: { "content-type": "application/json", "x-sendblue-signature": `t=${timestamp},v1=${signature}` }, body });
      requireOk(provider, response);
      results.push({ provider, checks: ["signed_status_callback"], status: "passed" });
      continue;
    }

    if (provider === "twilio") {
      const url = twilioUrl!;
      const params = { MessageSid: `SM${randomUUID().replace(/-/g, "")}`, MessageStatus: "delivered" };
      const body = new URLSearchParams(params).toString();
      const signatureInput = `${url}${Object.keys(params).sort().map((key) => `${key}${params[key as keyof typeof params]}`).join("")}`;
      const signature = hmac("sha1", config.twilioAuthToken!, signatureInput, "base64");
      const response = await request(provider, url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body });
      requireOk(provider, response);
      if (await responseText(response) !== "ok") throw new Error("Twilio staging status webhook returned an unexpected response.");
      results.push({ provider, checks: ["signed_status_callback"], status: "passed" });
      continue;
    }

    const crcToken = `chusky-smoke-${randomUUID()}`;
    const expectedToken = `sha256=${hmac("sha256", config.xchatConsumerSecret!, crcToken, "base64")}`;
    const crcUrl = new URL("/xchat/webhook", base);
    crcUrl.searchParams.set("crc_token", crcToken);
    const response = await request(provider, `${crcUrl.pathname}${crcUrl.search}`, { method: "GET" });
    requireOk(provider, response);
    const payload = JSON.parse(await responseText(response)) as { response_token?: unknown };
    if (typeof payload.response_token !== "string" || !secureEqual(payload.response_token, expectedToken)) throw new Error("XChat staging webhook returned an invalid CRC response.");
    results.push({ provider, checks: ["crc_challenge"], status: "passed" });
  }

  return { scope: "staging_webhook_boundaries_only", results, outboundMessagesSent: 0, fullProviderProofCreated: false, readinessChanged: false };
}
