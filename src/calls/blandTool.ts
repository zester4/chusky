import { isValidBlandToolSecret } from "./blandSecurity.js";

export interface BlandCustomToolDependencies {
  apiKey: string;
  webhookUrl: string;
  secret: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export function createBlandConsultToolDefinition(webhookUrl: string, secret: string) {
  if (!isValidBlandToolSecret(secret)) throw new Error("BLAND_CONSULT_TOOL_SECRET must be 32-256 URL-safe random characters");
  let endpoint: URL;
  try { endpoint = new URL(webhookUrl); } catch { throw new Error("BLAND_WEBHOOK_URL must be an absolute HTTPS URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("BLAND_WEBHOOK_URL must be an absolute HTTPS URL without credentials or fragments");
  endpoint.pathname = "/bland/tool";
  endpoint.search = "";
  return {
    name: "Consult Chusky",
    description: "Ask Chusky for a concise factual answer grounded in the purpose of this call when the caller asks a relevant question. This is read-only; it cannot perform actions. Ask one focused question and speak the answer naturally.",
    speech: "Let me check that against the information I have.",
    url: endpoint.toString(),
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: { call_id: "{{call_id}}", question: "{{input.question}}" },
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "A concise question for Chusky about the active call." } },
      required: ["question"],
    },
    response: { answer: "$.answer" },
    timeout: 15_000,
  };
}

/** Provision the documented v1 custom tool once, then attach its TL-* ID per call. */
export async function provisionBlandConsultTool(input: BlandCustomToolDependencies): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("BLAND_API_KEY is required");
  const definition = createBlandConsultToolDefinition(input.webhookUrl, input.secret);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)("https://api.bland.ai/v1/tools", {
      method: "POST",
      headers: { Authorization: input.apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(definition),
    });
  } catch {
    throw new Error("Could not reach Bland while provisioning Chusky's custom tool");
  }
  const payload = await response.json().catch(() => ({})) as { status?: string; tool_id?: string };
  if (!response.ok || payload.status !== "success" || typeof payload.tool_id !== "string" || !/^TL-[A-Za-z0-9_-]{6,128}$/.test(payload.tool_id)) {
    throw new Error(`Bland custom tool provisioning failed (HTTP ${response.status})`);
  }
  return payload.tool_id;
}
