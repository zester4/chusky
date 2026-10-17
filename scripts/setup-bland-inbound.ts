import "dotenv/config";
import { normalizeBlandInboundNumber, parseBlandInboundRoutes } from "../src/calls/blandInbound.js";

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cleanHttpsUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${label} must be a clean HTTPS URL`);
  return url;
}

try {
  const apiKey = required("BLAND_API_KEY");
  const toolId = required("BLAND_CONSULT_TOOL_ID");
  if (!/^TL-[A-Za-z0-9_-]{6,128}$/.test(toolId)) throw new Error("BLAND_CONSULT_TOOL_ID is not a valid Bland TL-* ID");
  const number = normalizeBlandInboundNumber(process.argv[2] ?? process.env.BLAND_INBOUND_PHONE_NUMBER);
  if (!number) throw new Error("Provide an E.164 inbound number as the first argument or BLAND_INBOUND_PHONE_NUMBER");
  const routes = parseBlandInboundRoutes(process.env.BLAND_INBOUND_ROUTES ?? "");
  if (!routes.has(number)) throw new Error(`BLAND_INBOUND_ROUTES has no owner mapping for ${number}`);

  const webhookBase = process.env.BLAND_INBOUND_WEBHOOK_URL?.trim()
    || `${(process.env.WEBHOOK_URL ?? "").replace(/\/+$/, "")}/bland/inbound/webhook`;
  const webhook = cleanHttpsUrl(webhookBase, "BLAND_INBOUND_WEBHOOK_URL");
  webhook.pathname = `${webhook.pathname.replace(/\/+$/, "")}/${number.slice(1)}`;
  const prompt = (process.env.BLAND_INBOUND_PROMPT?.trim() || [
    "You are Chusky, an AI phone representative answering an inbound call for the configured business.",
    "Disclose that you are an AI assistant, welcome the caller, understand what they need, and use only approved public or company information.",
    "When the caller asks for owner-private context, connected-app data, or an action, use the Consult Chusky tool with one focused question.",
    "Never reveal private information to an unverified caller, never claim an action succeeded without a confirmed result, and offer an owner follow-up when information or verification is missing.",
  ].join(" ")).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 12_000);

  const response = await fetch(`https://api.bland.ai/v1/inbound/${encodeURIComponent(number)}`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      prompt,
      voice: process.env.BLAND_VOICE?.trim() || "maya",
      first_sentence: process.env.BLAND_INBOUND_FIRST_SENTENCE?.trim() || "Hi, you’ve reached an AI assistant. How can I help today?",
      summary_prompt: "Summarize the caller's request, verified facts, decisions, unresolved questions, and explicit next steps. Do not invent action items.",
      webhook: webhook.toString(),
      webhook_events: ["queue", "call", "latency", "tool"],
      tools: [toolId],
    }),
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
  if (!response.ok || payload.success === false) throw new Error(`Bland inbound number update failed (HTTP ${response.status}): ${String(payload.message ?? payload.error ?? response.statusText).slice(0, 300)}`);
  console.log(`Configured Bland inbound number ${number} for Chusky account ${routes.get(number)!.userId}.`);
  console.log(`Bland callback: ${webhook.pathname}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Bland inbound setup failed");
  process.exitCode = 1;
}
