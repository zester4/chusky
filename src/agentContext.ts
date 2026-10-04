import type { ApiMessage } from "./types.js";

const MAX_MODEL_TOOL_RESULT_CHARS = 3_500;
const MAX_MODEL_CONTEXT_MESSAGES = 14;
const MAX_MODEL_CONTEXT_CHARS = 30_000;

function compactModelContent(content: ApiMessage["content"], maxChars = MAX_MODEL_TOOL_RESULT_CHARS): ApiMessage["content"] {
  if (typeof content !== "string" || content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.62);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n[… older tool output compacted for this model round …]\n${content.slice(-tail)}`;
}

/**
 * Keep the durable in-memory transcript intact, but send a bounded working
 * window to the model. OpenAI-compatible APIs require each tool result to
 * remain paired with its assistant tool call, so compaction removes complete
 * old exchanges and trims only the content of retained tool results.
 */
export function compactModelMessages(messages: ApiMessage[], maxMessages = MAX_MODEL_CONTEXT_MESSAGES, maxChars = MAX_MODEL_CONTEXT_CHARS): ApiMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  if (!conversation.length) return messages;

  let start = Math.max(0, conversation.length - Math.max(6, maxMessages));
  // Never begin with a tool result: its assistant tool-call envelope belongs
  // to the same exchange and must be retained for provider validation.
  while (start > 0 && conversation[start]?.role === "tool") start -= 1;
  const omitted = conversation.slice(0, start);
  const hadLargeToolResult = conversation.slice(start).some((message) => message.role === "tool" && typeof message.content === "string" && message.content.length > MAX_MODEL_TOOL_RESULT_CHARS);
  let retained = conversation.slice(start).map((message) => message.role === "tool"
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
  const summary = `Earlier in-turn context was compacted to keep the model request bounded. Full tool results remain available in the durable run state; retrieve them by call ID if needed.${omittedToolIds.length ? ` Omitted tool call IDs: ${omittedToolIds.join(", ")}.` : ""}\n${summaryLines.join("\n") || "Earlier tool exchanges remain available through their verified outcomes in the current run."}`;

  // Keep the latest exchange intact whenever possible, but put a hard bound on
  // retained tool payloads. This prevents several 8–20k provider responses
  // from being resent on every round without deleting the user objective or
  // the current assistant/tool pair.
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
  return [...systemMessages, ...(omitted.length || wasOverBudget || hadLargeToolResult ? [{ role: "system" as const, content: summary }] : []), ...retained];
}
