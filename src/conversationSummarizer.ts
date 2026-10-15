import { config } from "./config.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_INPUT_CHARS = 600_000;
const MAX_OUTPUT_CHARS = 8_000;

export type SummaryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationSummaryInput = {
  previousSummaries: string[];
  droppedMessages: SummaryMessage[];
  retainedMessages: SummaryMessage[];
};

function compactInput(input: ConversationSummaryInput): string {
  const sections = [
    input.previousSummaries.length
      ? `Existing durable summaries:\n${input.previousSummaries.slice(-3).join("\n\n")}`
      : "",
    input.droppedMessages.length
      ? `Older conversation being summarized:\n${input.droppedMessages.map((message) => `${message.role}: ${message.content}`).join("\n")}`
      : "",
    input.retainedMessages.length
      ? `Recent messages kept verbatim (use these to resolve continuity):\n${input.retainedMessages.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");

  if (sections.length <= MAX_INPUT_CHARS) return sections;
  const head = Math.floor(MAX_INPUT_CHARS * 0.82);
  return `${sections.slice(0, head)}\n[older summary input bounded by Chusky]\n${sections.slice(-MAX_INPUT_CHARS + head)}`;
}

function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (cleaned.length < 40) return undefined;
  return cleaned.slice(0, MAX_OUTPUT_CHARS);
}

export async function summarizeConversation(input: ConversationSummaryInput, signal?: AbortSignal): Promise<string | undefined> {
  if (!config.conversationSummaryEnabled || !config.openRouterApiKey) return undefined;

  const instructions = [
    "You are Chusky's durable conversation summarizer.",
    "Write a faithful, compact summary for a future agent turn.",
    "Do not invent facts, resolve ambiguity, or include commentary about summarization.",
    "Preserve only useful continuity: objective, decisions, preferences, important facts, dates, entities, constraints, pending tasks, open questions, and verified outcomes.",
    "Clearly label unverified claims and pending approvals. Never reproduce credentials, tokens, cookies, or private provider payloads.",
    "Use exactly these headings when applicable: Objective, Decisions, Facts and Constraints, Pending Work, Open Questions, Verified Outcomes.",
    "Keep the result under 700 tokens.",
  ].join(" ");

  try {
    for (let attempt = 0; attempt < config.conversationSummaryMaxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Request cancelled", "AbortError");
      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => attemptController.abort(new DOMException("Conversation summary timed out", "TimeoutError")), config.conversationSummaryTimeoutMs);
      try {
        const response = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openRouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://chusky-agent.example.com",
            "X-OpenRouter-Title": "Chusky Conversation Summarizer",
          },
          body: JSON.stringify({
            model: config.conversationSummaryModel,
            messages: [
              { role: "system", content: instructions },
              { role: "user", content: compactInput(input) },
            ],
            max_tokens: config.conversationSummaryMaxTokens,
          }),
          signal: attemptController.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt + 1 >= config.conversationSummaryMaxAttempts) {
            throw new Error(`ScaleDown summary request failed (${response.status}): ${detail.slice(0, 300)}`);
          }
          continue;
        }
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        return cleanSummary(payload.choices?.[0]?.message?.content);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt + 1 >= config.conversationSummaryMaxAttempts) throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  } catch (error) {
    throw error;
  }
  return undefined;
}
