import type { ApiMessage } from "./types.js";
import { summarizeConversation, type SummaryMessage } from "./conversationSummarizer.js";

const MAX_MODEL_TOOL_RESULT_CHARS = 3_500;
const MAX_MODEL_CONTEXT_MESSAGES = 14;
const MAX_MODEL_CONTEXT_CHARS = 30_000;
const MODEL_TOOL_DESCRIPTION_LIMIT = 320;
const MODEL_SCHEMA_DESCRIPTION_LIMIT = 120;

function compactSchemaDescriptions(value: unknown, descriptionLimit: number): unknown {
  if (Array.isArray(value)) return value.map((item) => compactSchemaDescriptions(item, descriptionLimit));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "examples" || key === "example") continue;
    if (key === "description" && typeof item === "string" && item.length > descriptionLimit) {
      output[key] = `${item.slice(0, descriptionLimit - 1).trimEnd()}…`;
      continue;
    }
    output[key] = compactSchemaDescriptions(item, descriptionLimit);
  }
  return output;
}

/**
 * Keep the executable tool contract complete while trimming verbose provider
 * prose from the model request. The full definitions remain in the trusted
 * execution catalog and are used for validation and dispatch.
 */
export function compactModelToolDefinition(tool: any): any {
  if (!tool?.function || typeof tool.function !== "object") return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      ...(typeof tool.function.description === "string"
        ? { description: tool.function.description.length > MODEL_TOOL_DESCRIPTION_LIMIT ? `${tool.function.description.slice(0, MODEL_TOOL_DESCRIPTION_LIMIT - 1).trimEnd()}…` : tool.function.description }
        : {}),
      ...(tool.function.parameters && typeof tool.function.parameters === "object"
        ? { parameters: compactSchemaDescriptions(tool.function.parameters, MODEL_SCHEMA_DESCRIPTION_LIMIT) }
        : {}),
    },
  };
}

/** Prefer the active mission step over its large continuation prompt for owner-context retrieval. */
export function contextSearchQuery(userMessage: string, missionStepObjective?: string): string {
  return (missionStepObjective?.trim() || userMessage.trim()).slice(0, 2_000);
}

/** Keep worker-only reference context bounded without trimming its source prefix. */
export function boundMissionContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n[… mission context shortened; retrieve exact source details if needed …]";
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function compactModelContent(content: ApiMessage["content"], maxChars = MAX_MODEL_TOOL_RESULT_CHARS): ApiMessage["content"] {
  if (typeof content !== "string" || content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.62);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n[… older tool output compacted for this model round …]\n${content.slice(-tail)}`;
}

function compactConversationContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n[… older conversation context compacted for this model round …]";
  if (maxChars <= marker.length) return content.slice(0, Math.max(0, maxChars));
  const head = Math.floor((maxChars - marker.length) * 0.62);
  const tail = maxChars - marker.length - head;
  return `${content.slice(0, head)}${marker}${content.slice(-tail)}`;
}

/**
 * Keep the durable in-memory transcript intact, but send a bounded working
 * window to the model. OpenAI-compatible APIs require each tool result to
 * remain paired with its assistant tool call, so compaction removes complete
 * old exchanges and trims only the content of retained tool results.
 */
function compactionWindow(messages: ApiMessage[], maxMessages: number): { systemMessages: ApiMessage[]; conversation: ApiMessage[]; omitted: ApiMessage[]; retained: ApiMessage[] } {
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  if (!conversation.length) return { systemMessages, conversation, omitted: [], retained: [] };

  let start = Math.max(0, conversation.length - Math.max(6, maxMessages));
  // Never begin with a tool result: its assistant tool-call envelope belongs
  // to the same exchange and must be retained for provider validation.
  while (start > 0 && conversation[start]?.role === "tool") start -= 1;
  return { systemMessages, conversation, omitted: conversation.slice(0, start), retained: conversation.slice(start) };
}

export function compactModelMessages(messages: ApiMessage[], maxMessages = MAX_MODEL_CONTEXT_MESSAGES, maxChars = MAX_MODEL_CONTEXT_CHARS, summaryOverride?: string): ApiMessage[] {
  const { systemMessages, conversation, omitted, retained: window } = compactionWindow(messages, maxMessages);
  if (!conversation.length) return messages;
  const hadLargeToolResult = window.some((message) => message.role === "tool" && typeof message.content === "string" && message.content.length > MAX_MODEL_TOOL_RESULT_CHARS);
  let retained = window.map((message) => message.role === "tool"
    ? { ...message, content: compactModelContent(message.content) }
    : message);
  const summaryLines = omitted
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string" ? message.content.replace(/\s+/g, " ").trim() : "";
      return text ? `${message.role}: ${text.slice(0, 500)}` : "";
    })
    .filter(Boolean)
    .slice(-6);
  const omittedToolIds = omitted.filter((message) => message.role === "tool" && message.tool_call_id).map((message) => message.tool_call_id).slice(-8);
  const summary = summaryOverride ?? `Earlier in-turn context was compacted to keep the model request bounded. Full tool results remain available in the durable run state; retrieve them by call ID if needed.${omittedToolIds.length ? ` Omitted tool call IDs: ${omittedToolIds.join(", ")}.` : ""}\n${summaryLines.join("\n") || "Earlier tool exchanges remain available through their verified outcomes in the current run."}`;

  // Keep the latest exchange intact whenever possible, but put a hard bound on
  // retained conversation and tool payloads. This prevents a large saved chat
  // plus a large tool catalogue from exceeding the provider prompt limit on a
  // new turn. Durable history remains unchanged; only this model request is
  // compacted.
  const contentLength = (items: ApiMessage[]) => items.reduce((total, item) => total + (typeof item.content === "string" ? item.content.length : JSON.stringify(item.content ?? "").length), 0);
  let chars = contentLength(retained);
  const wasOverBudget = chars > maxChars;
  if (chars > maxChars) {
    for (let index = 0; index < retained.length && chars > maxChars; index++) {
      const message = retained[index];
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      const compacted = compactModelContent(message.content, 1_600);
      chars -= message.content.length - String(compacted).length;
      retained[index] = { ...message, content: compacted };
    }
  }
  if (chars > maxChars) {
    // Historical user/assistant messages are safe to shorten as long as the
    // current request and complete assistant tool-call envelopes are retained.
    // Tool-call messages must remain byte-complete for provider validation.
    for (let index = 0; index < retained.length && chars > maxChars; index++) {
      const message = retained[index];
      if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || message.tool_calls?.length) continue;
      const excess = chars - maxChars;
      const target = Math.max(256, message.content.length - excess);
      if (target >= message.content.length) continue;
      const compacted = compactConversationContent(message.content, target);
      chars -= message.content.length - compacted.length;
      retained[index] = { ...message, content: compacted };
    }
  }
  return [...systemMessages, ...(omitted.length || wasOverBudget || hadLargeToolResult ? [{ role: "system" as const, content: summary }] : []), ...retained];
}

export async function compactModelMessagesWithSummary(
  messages: ApiMessage[],
  existingSummary?: string,
  maxMessages = MAX_MODEL_CONTEXT_MESSAGES,
  maxChars = MAX_MODEL_CONTEXT_CHARS,
): Promise<{ messages: ApiMessage[]; summary?: string }> {
  const compacted = compactModelMessages(messages, maxMessages, maxChars);
  if (existingSummary || compacted.length === messages.length) return { messages: compacted, ...(existingSummary ? { summary: existingSummary } : {}) };
  const { omitted } = compactionWindow(messages, maxMessages);
  if (!omitted.length) return { messages: compacted };
  const droppedMessages: SummaryMessage[] = omitted.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.role === "tool"
      ? `Tool result (untrusted evidence, ${message.tool_call_id ?? "unknown"}): ${typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")}`
      : typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
  }));
  const retainedMessages: SummaryMessage[] = messages.filter((message) => message.role !== "system").slice(-6).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
  }));
  const generated = await summarizeConversation({ previousSummaries: [], droppedMessages, retainedMessages }).catch(() => undefined);
  if (!generated) return { messages: compacted };
  return { messages: compactModelMessages(messages, maxMessages, maxChars, `[ScaleDown in-turn context summary]\n${generated}`), summary: generated };
}
