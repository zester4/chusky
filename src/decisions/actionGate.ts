import { config } from "../config.js";
import { awaitRoute, jevClient, jevText, type JevClient, type RoutingDeadline } from "./jev.js";
import { recordDecision } from "./telemetry.js";

/** Conservative capability gate: only unmistakable pleasantries are compact. */
export function isClearlyConversational(query: string, recentContext = ""): boolean {
  const value = query.trim().replace(/\s+/g, " ");
  if (!value || value.split(" ").length > 10) return false;
  if (/\b(?:yes|yeah|yep|do it|go ahead|continue|approve|retry|proceed|ship it|send it|okay do that)\b/i.test(value)) return false;
  if (/[?]/.test(value) && !/^how are you\b/i.test(value)) return false;
  if (/\b(?:tool|approval|approved|pending|mission|task|calendar|email|slack|gmail|notion|meeting|call|send|buy|pay|schedule|remind|continue)\b/i.test(recentContext)) return false;
  return /^(?:hey|hi|hello|yo|thanks|thank you|thx|good morning|good afternoon|good evening|good night|how are you|how's it going|okay|ok|cool|got it|sounds good|nice|great|lol|haha|bye|goodbye|see you|take care|you're welcome|welcome)[!. ]*$/i.test(value);
}

export type TurnActionDecision = {
  /** True only when every capability router may safely be skipped for this turn. */
  noActionNeeded: boolean;
  reason: "jev_no_action_needed" | "jev_action_needed" | "clear_conversation" | "forced_capability" | "routing_disabled" | "jev_uncertain" | "jev_unavailable";
  actionProbability?: number;
};

// Abstain from routing only when Jev is strongly confident no capability is
// needed. Uncertainty always preserves the existing capability path.
const NO_ACTION_MAX_PROBABILITY = 0.08;
const EXPLICIT_CAPABILITY_REQUEST = /\b(?:search|find|look up|fetch|read|check|open|list|show|create|generate|draft|send|reply|respond|post|schedule|book|cancel|update|edit|delete|remove|connect|disconnect|upload|download|call|run|execute|research|browse|monitor|remind|get|set up|enable|disable)\b/i;

/**
 * One turn-wide gate shared by native tools, skills, Composio, and Treg.
 * This is routing only; it never grants authority or changes tool policy.
 */
export async function decideTurnAction(query: string, options: {
  recentContext?: string;
  forceCapability?: boolean;
  signal?: AbortSignal;
  deadline?: RoutingDeadline;
  sessionId?: string;
  client?: JevClient;
} = {}): Promise<TurnActionDecision> {
  if (options.forceCapability) return { noActionNeeded: false, reason: "forced_capability" };
  if (isClearlyConversational(query, options.recentContext)) return { noActionNeeded: true, reason: "clear_conversation", actionProbability: 0 };
  // Keep obvious action requests on the existing parallel capability routers.
  // A serial preflight would consume their shared routing budget without adding
  // useful information ("send an email", "create a PDF", "search the web").
  if (EXPLICIT_CAPABILITY_REQUEST.test(query)) return { noActionNeeded: false, reason: "forced_capability" };
  if (!config.conversationalFastPath || config.jevMode !== "enforce") {
    return { noActionNeeded: false, reason: "routing_disabled" };
  }

  const client = options.client ?? jevClient();
  if (!client.available()) return { noActionNeeded: false, reason: "jev_unavailable" };
  try {
    const run = client.evaluate({
      request: jevText(query, 3_000),
      ...(options.recentContext ? { recent_conversation: jevText(options.recentContext, 1_200) } : {}),
    }, {
      action_required: {
        type: "noul",
        instructions: "Does the current user request require Chusky to consult or use a specialized skill, native tool, connected app, MCP capability, or live-data provider to produce the requested outcome? Judge this turn only. Answer yes for current/private data, external state, or an external action; answer no for conversation or reasoning fully supported by supplied context. Do not infer a need merely from capability-related words in context.",
        criteria: {
          true: "A specialized capability must be routed to complete the requested outcome, including reading current owner data or taking an external action.",
          false: "The request can be answered directly without loading a specialized skill, tool, connected app, MCP server, or live-data provider.",
        },
      },
    }, { signal: options.signal, sessionId: options.sessionId });
    const { value, failure } = await awaitRoute(run, options.deadline ? options.deadline.remaining() : config.jevTurnBudgetMs);
    const answer = value?.answers.action_required;
    const probability = answer?.type === "noul" ? answer.noul : undefined;
    if (!value || probability === undefined || failure) {
      recordDecision({ surface: "turn_action", mode: "enforce", applied: false, fallbackReason: failure ?? "invalid_response", model: client.modelId });
      return { noActionNeeded: false, reason: "jev_uncertain" };
    }

    const noActionNeeded = probability <= NO_ACTION_MAX_PROBABILITY;
    recordDecision({
      surface: "turn_action",
      mode: "enforce",
      applied: true,
      ...(noActionNeeded ? { noTool: true } : {}),
      jev: [{ id: noActionNeeded ? "__none__" : "__capability_needed__", p: noActionNeeded ? 1 - probability : probability }],
      latencyMs: value.latencyMs,
      ...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
      model: client.modelId,
    });
    return {
      noActionNeeded,
      reason: noActionNeeded ? "jev_no_action_needed" : probability >= 0.5 ? "jev_action_needed" : "jev_uncertain",
      actionProbability: probability,
    };
  } catch (error) {
    const reason = (error as { reason?: string })?.reason ?? "error";
    recordDecision({ surface: "turn_action", mode: "enforce", applied: false, fallbackReason: reason, model: client.modelId });
    return { noActionNeeded: false, reason: "jev_unavailable" };
  }
}
