import type { ApiMessage } from "./types.js";

const MAX_MODEL_TOOL_RESULT_CHARS = 8_000;
const MAX_MODEL_CONTEXT_MESSAGES = 18;

function compactModelContent(content: ApiMessage["content"]): ApiMessage["content"] {
  if (typeof content !== "string" || content.length <= MAX_MODEL_TOOL_RESULT_CHARS) return content;
  const head = Math.floor(MAX_MODEL_TOOL_RESULT_CHARS * 0.62);
  const tail = MAX_MODEL_TOOL_RESULT_CHARS - head;
  return `${content.slice(0, head)}\n[… older tool output compacted for this model round …]\n${content.slice(-tail)}`;
}

/**
 * Keep the durable in-memory transcript intact, but send a bounded working
 * window to the model. OpenAI-compatible APIs require each tool result to
 * remain paired with its assistant tool call, so compaction removes complete
 * old exchanges and trims only the content of retained tool results.
 */
export function compactModelMessages(messages: ApiMessage[], maxMessages = MAX_MODEL_CONTEXT_MESSAGES): ApiMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  if (!conversation.length) return messages;

  let start = Math.max(0, conversation.length - Math.max(6, maxMessages));
  // Never begin with a tool result: its assistant tool-call envelope belongs
  // to the same exchange and must be retained for provider validation.
  while (start > 0 && conversation[start]?.role === "tool") start -= 1;
  const omitted = conversation.slice(0, start);
  const retained = conversation.slice(start).map((message) => message.role === "tool"
    ? { ...message, content: compactModelContent(message.content) }
    : message);
  if (!omitted.length) return [...systemMessages, ...retained];

  const summaryLines = omitted
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string" ? message.content.replace(/\s+/g, " ").trim() : "";
      return text ? `${message.role}: ${text.slice(0, 500)}` : "";
    })
    .filter(Boolean)
    .slice(-6);
  const summary = `Earlier in-turn context was compacted to keep the model request bounded.\n${summaryLines.join("\n") || "Earlier tool exchanges remain available through their verified outcomes in the current run."}`;
  return [...systemMessages, { role: "system", content: summary }, ...retained];
}
