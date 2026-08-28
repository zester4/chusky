/**
 * Chuck's brain — Composio ToolRouter session + OpenRouter inference.
 *
 * Architecture:
 *   1. On first message, create a Composio ToolRouter session for the user.
 *      The session gives Chuck access to 1000+ tools with Composio managed auth,
 *      COMPOSIO_MANAGE_CONNECTIONS (OAuth flow links), COMPOSIO_REMOTE_BASH_TOOL,
 *      COMPOSIO_REMOTE_WORKBENCH, and our local calculator.
 *
 *   2. Call session.tools() to get the full tool schema array.
 *      These are OpenAI-function-call compatible descriptors.
 *
 *   3. Run the agentic loop against OpenRouter's Chat Completions API:
 *      POST /chat/completions with messages + tools
 *      → finish_reason === "tool_calls"
 *      → execute each call via session.execute(slug, args)
 *      → append tool results, loop
 *      → finish_reason === "stop" → return text
 *
 * Composio docs references:
 *   https://docs.composio.dev/docs/sessions
 *   https://docs.composio.dev/docs/triggers
 *   COMPOSIO_MANAGE_CONNECTIONS, COMPOSIO_REMOTE_BASH_TOOL, COMPOSIO_REMOTE_WORKBENCH
 */

import { Composio } from "@composio/core";
import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getSession, saveSession, setComposioSessionId } from "./store.js";
import type { Message } from "./store.js";
import { nativeTool } from "./nativeTools.js";

// ── Composio client singleton ─────────────────────────────────────────────────
const composio = new Composio({ apiKey: config.composioApiKey });

// ── OpenRouter fetch ──────────────────────────────────────────────────────────
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const LOCAL_TOOLS = [
  { type: "function", function: { name: "CHUCK_GENERATE_IMAGE", description: "Generate an image and send it to the user.", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } },
  { type: "function", function: { name: "CHUCK_CREATE_TRIGGER", description: "Create a Composio trigger for the user.", parameters: { type: "object", properties: { slug: { type: "string" }, triggerConfig: { type: "object", additionalProperties: true } }, required: ["slug"] } } },
  { type: "function", function: { name: "CHUCK_GENERATE_VIDEO", description: "Start an asynchronous video generation job.", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } },
  { type: "function", function: { name: "CHUCK_SET_REMINDER", description: "Set a durable one-time reminder. Provide delaySeconds or a future ISO runAt.", parameters: { type: "object", properties: { text: { type: "string" }, delaySeconds: { type: "number" }, runAt: { type: "string", description: "Future ISO-8601 timestamp" } }, required: ["text"] } } },
  { type: "function", function: { name: "CHUCK_LIST_REMINDERS", description: "List the user's active reminders.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "CHUCK_CANCEL_REMINDER", description: "Cancel one of the user's reminders by ID.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "CHUCK_SCHEDULE_JOB", description: "Schedule a recurring user notification using a 5-field CRON expression.", parameters: { type: "object", properties: { text: { type: "string" }, cron: { type: "string" } }, required: ["text", "cron"] } } },
  { type: "function", function: { name: "CHUCK_LIST_JOBS", description: "List the user's active recurring jobs.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "CHUCK_CANCEL_JOB", description: "Cancel one of the user's recurring jobs by ID.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "CHUCK_SCRATCHPAD_WRITE", description: "Save a private per-user working note for later turns.", parameters: { type: "object", properties: { key: { type: "string" }, content: { type: "string" } }, required: ["key", "content"] } } },
  { type: "function", function: { name: "CHUCK_SCRATCHPAD_READ", description: "Read private scratchpad notes, optionally filtered by a search query.", parameters: { type: "object", properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "CHUCK_SCRATCHPAD_CLEAR", description: "Clear one private scratchpad note or the entire scratchpad.", parameters: { type: "object", properties: { key: { type: "string" } } } } },
];

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "video_url"; video_url: { url: string } };

function requiredModality(message: string | ContentPart[]): string | undefined {
  if (typeof message === "string") return undefined;
  if (message.some((p) => p.type === "image_url")) return "image";
  if (message.some((p) => p.type === "file")) return "file";
  if (message.some((p) => p.type === "video_url")) return "video";
  return undefined;
}

interface Choice {
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  message: ApiMessage;
}

interface ChatResponse {
  choices: Choice[];
  usage?: { cost?: number };
}

async function readStreamingChat(res: Response, onDelta?: (text: string) => void | Promise<void>): Promise<ChatResponse> {
  if (!res.body) throw new Error("OpenRouter returned an empty stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const calls = new Map<number, ToolCall>();
  let usage: { cost?: number } | undefined;
  const consume = async (line: string) => {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") return;
    const chunk = JSON.parse(raw) as any;
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") { content += delta.content; if (onDelta) await onDelta(delta.content); }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      existing.id += call.id ?? "";
      existing.function.name += call.function?.name ?? "";
      existing.function.arguments += call.function?.arguments ?? "";
      calls.set(index, existing);
    }
    if (chunk.usage) usage = { cost: chunk.usage.cost };
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) await consume(line.trim());
    if (done) break;
  }
  return { choices: [{ finish_reason: calls.size ? "tool_calls" : "stop", message: { role: "assistant", content, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) } }], usage };
}

async function orChat(
  model: string,
  messages: ApiMessage[],
  tools: unknown[],
  signal?: AbortSignal,
  onDelta?: (text: string) => void | Promise<void>
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    try {
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://chuck-agent.example.com",
          "X-OpenRouter-Title": "Chuck AI Agent",
        },
        body: JSON.stringify({ ...body, stream: Boolean(onDelta), ...(onDelta ? { stream_options: { include_usage: true } } : {}) }),
        signal,
      });
      if (res.ok) return onDelta ? readStreamingChat(res, onDelta) : res.json() as Promise<ChatResponse>;
      const err = await res.text().catch(() => res.statusText);
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) {
        throw new Error(`OpenRouter ${res.status}: ${err}`);
      }
      lastError = new Error(`OpenRouter ${res.status}: ${err}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt + Math.random() * 250));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ── Tool status display ───────────────────────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  COMPOSIO_MANAGE_CONNECTIONS: "🔗 Opening connection manager…",
  COMPOSIO_REMOTE_BASH_TOOL: "🖥️ Running shell command…",
  COMPOSIO_REMOTE_WORKBENCH: "🛠️ Working in remote environment…",
  COMPOSIO_SEARCH_TOOL: "🔎 Searching available tools…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "⚡ Batch executing tools…",
};

function toolStatus(slug: string): string {
  if (TOOL_STATUS[slug]) return TOOL_STATUS[slug];
  // Infer from slug pattern e.g. GITHUB_CREATE_ISSUE → GitHub
  const parts = slug.split("_");
  const toolkit = parts[0] ? (parts[0].charAt(0) + parts[0].slice(1).toLowerCase()) : slug;
  const action = parts.slice(1).join(" ").toLowerCase();
  return `⚙️ ${toolkit}: ${action}…`;
}

// ── Composio session management ───────────────────────────────────────────────
// We create one Composio ToolRouter session per user and persist its ID.
// On subsequent messages we reuse the same session (stateful context on Composio's side).

interface ComposioSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionObj: any;
  sessionId: string;
}

const sessionCache = new Map<number, ComposioSession>();

async function getOrCreateComposioSession(userId: number): Promise<ComposioSession> {
  // Check in-process cache first
  const cached = sessionCache.get(userId);
  if (cached) return cached;

  // Check persistent store for an existing session ID
  const stored = await getSession(userId);
  const userId_str = `user_${userId}`;

  logger.debug({ userId, existingSessionId: stored.composioSessionId }, "Getting Composio session");

  // Create (or re-attach to) a Composio ToolRouter session
  // composio.create() returns a session we can call .tools() and .execute() on
  const createSession = () => composio.create(userId_str, {
    manageConnections: {
      enable: config.enableManageConnections,
      ...(config.composioCallbackUrl ? { callbackUrl: config.composioCallbackUrl } : {}),
    },
    sandbox: {
      enable: config.enableSandbox,
      sandboxSize: config.sandboxSize,
    },
  });
  const sessionObj = stored.composioSessionId
    ? await composio.sessions.use(stored.composioSessionId).catch(createSession)
    : await createSession();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionId = (sessionObj as any).sessionId ?? (sessionObj as any).id ?? userId_str;

  const result: ComposioSession = { sessionObj, sessionId };
  sessionCache.set(userId, result);
  await setComposioSessionId(userId, sessionId);

  logger.info({ userId, sessionId }, "Composio session ready");
  return result;
}

// ── Agent result ──────────────────────────────────────────────────────────────

export interface AgentResult {
  text: string;
  toolsUsed: string[];
  cost?: number;
  generatedImages?: { data: Buffer; mediaType: string; cost?: number }[];
}

// ── Core agentic loop ─────────────────────────────────────────────────────────

export async function runAgent(
  userId: number,
  userMessage: string | ContentPart[],
  history: Message[],
  model: string,
  onStatus?: (msg: string) => void | Promise<void>,
  signal?: AbortSignal,
  onDelta?: (text: string) => void | Promise<void>
): Promise<AgentResult> {

  if (onStatus) await onStatus("🧠 Initialising Chuck…");

  // Get Composio session for this user
  const { sessionObj } = await getOrCreateComposioSession(userId);

  if (onStatus) await onStatus("🔌 Loading tools…");

  // Fetch the full tool list from Composio (1000+ tools + meta tools)
  // These are OpenAI-compatible function descriptors
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const composioTools: any[] = await sessionObj.tools();
  composioTools.push(...LOCAL_TOOLS);

  const capabilityModel = model.replace(/^~/, "");
  try {
    const modelRes = await fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(capabilityModel)}`, {
      headers: { Authorization: `Bearer ${config.openRouterApiKey}` }, signal,
    });
    if (modelRes.ok) {
      const metadata = await modelRes.json() as any;
      const architecture = metadata.data?.architecture ?? metadata.architecture ?? {};
      const supported = metadata.data?.supported_parameters ?? metadata.supported_parameters ?? {};
      const modality = requiredModality(userMessage);
      const inputs = architecture.input_modalities ?? [];
      if (modality && inputs.length && !inputs.includes(modality)) {
        throw new Error(`Model ${model} does not support ${modality} input. Choose a compatible model with /model.`);
      }
      if (composioTools.length && Object.keys(supported).length && !supported.tools) {
        logger.warn({ model }, "Selected model metadata does not advertise tool calling");
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("does not support")) throw e;
    logger.debug({ err: e, model }, "Model capability lookup unavailable");
  }

  logger.debug({ toolCount: composioTools.length }, "Composio tools loaded");

  // Build message array for OpenRouter
  const messages: ApiMessage[] = [
    { role: "system", content: config.chuckSystemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];

  const toolsUsed: string[] = [];
  let totalCost = 0;
  const generatedImages: AgentResult["generatedImages"] = [];

  for (let round = 0; round < config.maxToolRounds; round++) {
    logger.debug({ round, model, messageCount: messages.length }, "Agent round");

    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const response = await orChat(model, messages, composioTools, signal, onDelta);
    if (response.usage?.cost) totalCost += response.usage.cost;

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices in OpenRouter response");

    const { finish_reason, message: assistantMsg } = choice;
    const toolCalls = assistantMsg.tool_calls ?? [];

    // ── Done: no tool calls or explicit stop ──────────────────────────
    if (finish_reason === "stop" || toolCalls.length === 0) {
      const text = assistantMsg.content ?? "";
      logger.info({ model, round, toolsUsed, cost: totalCost }, "Chuck done");
      return { text: typeof text === "string" ? text.trim() : "", toolsUsed, cost: totalCost, generatedImages };
    }

    // ── Tool calls: execute via Composio session ───────────────────────
    messages.push({
      role: "assistant",
      content: assistantMsg.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const slug = call.function.name;
      if (!toolsUsed.includes(slug)) toolsUsed.push(slug);

      if (onStatus) await onStatus(toolStatus(slug));
      logger.debug({ slug, args: call.function.arguments }, "Tool call");

      let result: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        // session.execute() routes the call through Composio:
        // - meta tools (COMPOSIO_MANAGE_CONNECTIONS, COMPOSIO_REMOTE_BASH_TOOL, etc.) → Composio server
        // - app tools (GITHUB_CREATE_ISSUE, GMAIL_SEND_EMAIL, etc.) → Composio → provider API
        let execResult: unknown;
        if (slug === "CHUCK_GENERATE_IMAGE") {
          const image = await generateImage(String(args.prompt ?? ""));
          generatedImages.push(image);
          execResult = "Image generated successfully. It will be sent to the user.";
        } else if (slug === "CHUCK_CREATE_TRIGGER") {
          execResult = await createTrigger(userId, String(args.slug ?? ""), { triggerConfig: args.triggerConfig ?? {} });
        } else if (slug === "CHUCK_GENERATE_VIDEO") {
          execResult = await queueVideoWorkflow(userId, String(args.prompt ?? ""));
        } else if (slug.startsWith("CHUCK_")) {
          execResult = await nativeTool(userId, slug, args);
        } else {
          execResult = await sessionObj.execute(slug, args);
        }
        result = typeof execResult === "string"
          ? execResult
          : JSON.stringify(execResult);
      } catch (e) {
        logger.warn({ slug, err: e }, "Tool execution failed");
        result = `Error executing ${slug}: ${String(e)}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // ── Max rounds exhausted — force final answer ─────────────────────────
  logger.warn({ model, toolsUsed }, "Max tool rounds reached");
  if (onStatus) await onStatus("✍️ Composing final answer…");

  const final = await orChat(model, messages, [], signal, onDelta);
  if (final.usage?.cost) totalCost += final.usage.cost;
  const text = final.choices[0]?.message?.content ?? "";

  return { text: typeof text === "string" ? text.trim() : "", toolsUsed, cost: totalCost, generatedImages };
}

// ── Get connection URL for a toolkit (for the /connect command) ───────────────

export async function getConnectionUrl(
  userId: number,
  toolkit: string
): Promise<string> {
  const { sessionObj } = await getOrCreateComposioSession(userId);
  const req = await sessionObj.authorize(toolkit, {
    ...(config.composioCallbackUrl ? { callbackUrl: config.composioCallbackUrl } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).redirectUrl ?? (req as any).url ?? String(req);
}

// ── Get toolkit connection states ─────────────────────────────────────────────

export async function getToolkitStates(
  userId: number
): Promise<{ slug: string; name: string; connected: boolean; logo?: string }[]> {
  const { sessionObj } = await getOrCreateComposioSession(userId);
  const result = await sessionObj.toolkits();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result.items as any[]).map((t: any) => ({
    slug: t.slug as string,
    name: t.name as string,
    logo: t.logo as string | undefined,
    connected: Boolean(t.connection?.isActive),
  }));
}

export async function searchTools(userId: number, query: string): Promise<unknown[]> {
  const { sessionObj } = await getOrCreateComposioSession(userId);
  const result = await sessionObj.search({ query });
  return Array.isArray(result) ? result : (result.items ?? []);
}

export async function listTriggers(userId: number): Promise<unknown[]> {
  const result = await composio.triggers.listActive({ showDisabled: true });
  const items = Array.isArray(result) ? result : ((result as any).items ?? []);
  const owned = new Set((await getSession(userId)).triggerIds ?? []);
  return items.filter((t: any) => owned.has(String(t.id ?? t.trigger_id ?? t.triggerId)));
}

export async function createTrigger(userId: number, slug: string, body: Record<string, unknown>): Promise<unknown> {
  const result = await composio.triggers.create(`user_${userId}`, slug, body as any);
  const session = await getSession(userId);
  const id = String((result as any).triggerId ?? (result as any).id ?? "");
  if (id) { session.triggerIds = [...new Set([...(session.triggerIds ?? []), id])]; await saveSession(userId, session); }
  return result;
}

export async function setTriggerState(userId: number, id: string, enabled: boolean): Promise<unknown> {
  if (!(await getSession(userId)).triggerIds?.includes(id)) throw new Error("You do not own this trigger");
  return enabled ? composio.triggers.enable(id) : composio.triggers.disable(id);
}

export async function deleteTrigger(userId: number, id: string): Promise<unknown> {
  const session = await getSession(userId);
  if (!(session.triggerIds ?? []).includes(id)) throw new Error("You do not own this trigger");
  const result = await composio.triggers.delete(id);
  session.triggerIds = session.triggerIds.filter((triggerId) => triggerId !== id);
  await saveSession(userId, session);
  return result;
}

// ── Invalidate cached session (e.g. after /clear) ────────────────────────────

export function invalidateSession(userId: number): void {
  sessionCache.delete(userId);
}

// ── Model listing ─────────────────────────────────────────────────────────────

export interface ModelInfo { id: string; name: string }

let modelCache: ModelInfo[] | null = null;
let modelCacheTs = 0;

export async function fetchModels(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCacheTs < 5 * 60 * 1000) return modelCache;
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
  const json = (await res.json()) as { data: { id: string; name: string }[] };
  modelCache = json.data.map((m) => ({ id: m.id, name: m.name }));
  modelCacheTs = Date.now();
  return modelCache;
}

export async function transcribeAudio(data: Buffer, format: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.transcriptionModel, input_audio: { data: data.toString("base64"), format } }),
  });
  if (!res.ok) throw new Error(`OpenRouter transcription ${res.status}: ${await res.text()}`);
  const result = await res.json() as { text?: string };
  if (!result.text) throw new Error("Transcription returned no text");
  return result.text;
}

export async function generateImage(prompt: string): Promise<{ data: Buffer; mediaType: string; cost?: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.imageModel, prompt }),
  });
  if (!res.ok) throw new Error(`OpenRouter image generation ${res.status}: ${await res.text()}`);
  const result = await res.json() as { data?: { b64_json?: string; media_type?: string }[]; usage?: { cost?: number } };
  const image = result.data?.[0];
  if (!image?.b64_json) throw new Error("Image generation returned no image");
  return { data: Buffer.from(image.b64_json, "base64"), mediaType: image.media_type || "image/png", cost: result.usage?.cost };
}

export async function queueVideoWorkflow(userId: number, prompt: string): Promise<string> {
  if (!config.qstashToken || !config.videoWorkflowUrl) {
    throw new Error("Video workflows are not configured. Set QSTASH_TOKEN and VIDEO_WORKFLOW_URL.");
  }
  const client = new WorkflowClient({ token: config.qstashToken });
  const result = await client.trigger({ url: config.videoWorkflowUrl, body: { userId, prompt } });
  return `Video generation started. Workflow ID: ${result.workflowRunId}`;
}

// ── Trigger webhook handler ───────────────────────────────────────────────────

export interface TriggerEvent {
  eventId: string;
  triggerSlug: string;
  userId: string;
  payload: Record<string, unknown>;
  rawPayload: unknown;
}

export async function parseTriggerWebhook(
  body: Buffer,
  headers: Record<string, string>,
  secret?: string
): Promise<TriggerEvent | null> {
    const result = await composio.triggers.parse(
      { body, headers } as Parameters<typeof composio.triggers.parse>[0],
      secret ? { verifySecret: secret } : undefined
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    if (r?.rawPayload?.type !== "composio.trigger.message") return null;
    const eventId = String(r.rawPayload?.id ?? r.rawPayload?.eventId ?? r.payload?.eventId ?? "");
    if (!eventId) throw new Error("Composio trigger event has no event ID");
    return {
      eventId,
      triggerSlug: r.payload?.triggerSlug ?? r.payload?.trigger_slug ?? "",
      userId: r.payload?.userId ?? r.payload?.user_id ?? "",
      payload: r.payload?.payload ?? {},
      rawPayload: r.rawPayload,
    };
}
