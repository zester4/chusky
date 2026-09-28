import { config } from "../config.js";
import { isReadOnlyToolSlug } from "../policy.js";
import { modelFacingChuckTools } from "../agentTools.js";
import { awaitRoute, jevClient, jevEnabled, jevText, rankOptions, type JevClient, type RoutingDeadline } from "./jev.js";
import { recordDecision } from "./telemetry.js";

type ToolSchema = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
};

export type NativeToolBundle =
  | "core"
  | "workspace"
  | "browser"
  | "meetings"
  | "artifacts"
  | "code"
  | "autonomy"
  | "intelligence"
  | "shopping"
  | "other";

export type NativeToolRisk = "read" | "write" | "high_impact";

export type NativeToolDescriptor = {
  slug: string;
  description: string;
  bundle: NativeToolBundle;
  risk: NativeToolRisk;
  alwaysAvailable: boolean;
};

export type NativeToolRoute = {
  tools: ToolSchema[];
  source: "jev" | "fallback";
  candidateCount: number;
  selected: string[];
  fallbackReason?: string;
  telemetry?: {
    latencyMs: number;
    costUsd: number;
    ranked?: Array<{ id: string; probability: number }>;
  };
};

const CORE_TOOLS = new Set([
  "CHUCK_SEARCH_SKILLS",
  "CHUCK_LIST_SKILL_FILES",
  "CHUCK_READ_SKILL_FILE",
  "CHUCK_TOOL_PREFLIGHT",
  "CHUCK_TOOL_RECOVERY",
  "CHUCK_INTEGRATION_HEALTH",
  "CHUCK_CONTEXT_SEARCH",
  "CHUCK_AUTONOMY_STATUS",
  "CHUCK_TASK_WAIT",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "and", "or", "of", "for", "my", "me", "in", "on", "with", "this", "that", "is", "it", "by", "from", "our", "your", "can", "you", "please", "do", "get", "use",
]);

const BUNDLE_TERMS: Record<NativeToolBundle, string[]> = {
  core: ["tool", "skill", "context", "memory", "health", "status"],
  workspace: ["email", "calendar", "slack", "github", "crm", "notion", "message", "trigger", "webhook", "connected", "account"],
  browser: ["browser", "website", "web", "page", "login", "vault", "password", "form", "click", "scroll", "checkout"],
  meetings: ["meeting", "zoom", "meet", "teams", "webex", "call", "participant", "transcript"],
  artifacts: ["pdf", "document", "docx", "spreadsheet", "excel", "presentation", "slide", "artifact", "image", "video"],
  code: ["code", "file", "folder", "sandbox", "app", "build", "deploy", "terminal", "repository", "git"],
  autonomy: ["task", "mission", "reminder", "follow-up", "followup", "schedule", "delegate", "attention", "proactive", "loop"],
  intelligence: ["treg", "mcp", "research", "enrich", "company", "person", "seo", "search", "provider", "data"],
  shopping: ["shop", "shopping", "order", "purchase", "cart", "merchant", "payment", "stripe", "link wallet"],
  other: [],
};

function toolName(tool: ToolSchema): string {
  return String(tool.function?.name ?? "").trim().toUpperCase();
}

function compactDescription(tool: ToolSchema): string {
  const description = jevText(tool.function?.description ?? toolName(tool).replace(/^CHUCK_/, "").replace(/_/g, " "), 260);
  return description.replace(/\s+/g, " ").trim() || toolName(tool);
}

function inferBundle(slug: string, description: string): NativeToolBundle {
  const text = `${slug} ${description}`.toLowerCase();
  if (/treg|mcp|enrich|provider|seo|social|market|research/.test(text)) return "intelligence";
  if (/browser|vault|checkout|login|webpage|website/.test(text)) return "browser";
  if (/meeting|zoom|teams|webex|transcript|phone|call/.test(text)) return "meetings";
  if (/pdf|document|spreadsheet|presentation|artifact|image|video/.test(text)) return "artifacts";
  if (/daytona|code|file|folder|sandbox|workspace|terminal|git|repository|\bapp\b/.test(text)) return "code";
  if (/mission|task|reminder|attention|autonomy|subagent|delegate|follow.?up|schedule/.test(text)) return "autonomy";
  if (/shopping|order|payment|merchant|wallet|cart/.test(text)) return "shopping";
  if (/email|calendar|slack|github|notion|trigger|webhook|account|connection|message/.test(text)) return "workspace";
  return "other";
}

function inferRisk(slug: string): NativeToolRisk {
  if (/(DELETE|FORGET|PURGE|DESTROY|PAYMENT|PURCHASE|CHECKOUT|PLACE_ORDER|DEPLOY|PUSH|REVOKE|PERMISSION|CHANGE_ROLE|TRANSFER|CALL|SEND)/i.test(slug)) return "high_impact";
  if (isReadOnlyToolSlug(slug)) return "read";
  return "write";
}

function descriptorFor(tool: ToolSchema): NativeToolDescriptor | undefined {
  const slug = toolName(tool);
  if (!slug.startsWith("CHUCK_") || slug === "CHUCK_MEDIA_BRIDGE") return undefined;
  const description = compactDescription(tool);
  const bundle = inferBundle(slug, description);
  return { slug, description, bundle, risk: inferRisk(slug), alwaysAvailable: CORE_TOOLS.has(slug) };
}

/**
 * Compact, model-facing metadata for every published native tool. Full JSON
 * schemas stay in agentTools.ts and are never sent to Jev.
 */
export const nativeToolManifest: NativeToolDescriptor[] = modelFacingChuckTools
  .map(descriptorFor)
  .filter((item): item is NativeToolDescriptor => Boolean(item));

const descriptorBySlug = new Map(nativeToolManifest.map((item) => [item.slug, item]));

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function relevance(query: string, descriptor: NativeToolDescriptor): number {
  const requestWords = new Set(words(query));
  const descriptorWords = new Set(words(`${descriptor.slug} ${descriptor.description}`));
  let score = 0;
  for (const word of requestWords) if (descriptorWords.has(word)) score += 2;
  const bundleWords = BUNDLE_TERMS[descriptor.bundle];
  for (const word of requestWords) if (bundleWords.includes(word)) score += 3;
  if (requestWords.has(descriptor.slug.toLowerCase().replace(/^chuck_/, "").replace(/_/g, " "))) score += 8;
  return score;
}

function baselineRoute(tools: ToolSchema[], reason?: string): NativeToolRoute {
  return {
    tools,
    source: "fallback",
    candidateCount: tools.filter((tool) => descriptorBySlug.has(toolName(tool))).length,
    selected: tools.filter((tool) => descriptorBySlug.has(toolName(tool))).map(toolName).slice(0, 40),
    ...(reason ? { fallbackReason: reason } : {}),
  };
}

function candidateSet(tools: ToolSchema[], query: string): { candidates: NativeToolDescriptor[]; matched: boolean } {
  const available = tools.map((tool) => descriptorBySlug.get(toolName(tool))).filter((item): item is NativeToolDescriptor => Boolean(item));
  const scored = available
    .map((item) => ({ item, score: relevance(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug));
  if (!scored.length) return { candidates: [], matched: false };
  const max = Math.max(4, config.jevNativeToolMaxCandidates);
  const core = available.filter((item) => item.alwaysAvailable);
  const selected = [...core, ...scored.map((entry) => entry.item)]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.slug === item.slug) === index)
    .slice(0, max);
  return { candidates: selected, matched: true };
}

function modelToolsForSelection(tools: ToolSchema[], selected: Set<string>): ToolSchema[] {
  return tools.filter((tool) => {
    const slug = toolName(tool);
    return !descriptorBySlug.has(slug) || selected.has(slug);
  });
}

export async function computeNativeToolRoute(query: string, tools: ToolSchema[], options: {
  client?: JevClient;
  signal?: AbortSignal;
  recentContext?: string;
  sessionId?: string;
} = {}): Promise<NativeToolRoute> {
  const baseline = baselineRoute(tools);
  const availableNative = tools.filter((tool) => descriptorBySlug.has(toolName(tool)));
  if (!availableNative.length) return baseline;
  const candidates = candidateSet(tools, query);
  if (!candidates.matched || candidates.candidates.length < 2) return { ...baseline, fallbackReason: "no_native_candidate_set" };
  const client = options.client ?? jevClient();
  const state = {
    request: jevText(query, 3_000),
    ...(options.recentContext ? { recent_conversation: jevText(options.recentContext, 1_200) } : {}),
  };
  const ranking = await rankOptions(client, {
    state,
    instructions: "Which native Chusky tools should be available to the main agent for this request? Choose tools that directly help complete the work. Include only tools that are necessary or likely next steps; do not choose tools merely because they are broadly capable.",
    options: candidates.candidates.map((item) => ({
      id: item.slug,
      description: `${item.bundle} ${item.risk} tool: ${item.description}`,
    })),
    noneDescription: "No native tool is needed: answer conversationally or use another already-routed capability.",
    signal: options.signal,
    maxPerQuestion: Math.max(8, config.jevNativeToolMaxCandidates),
    sessionId: options.sessionId,
  });
  const best = ranking.ranked[0];
  if (!best || ranking.confidence < config.jevNativeToolMinConfidence || ranking.none >= ranking.confidence) {
    return {
      ...baseline,
      candidateCount: candidates.candidates.length,
      fallbackReason: "low_confidence_or_none",
      telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
    };
  }
  const selected = ranking.ranked
    .filter((item) => item.probability >= config.jevNativeToolMinProbability)
    .slice(0, Math.min(12, config.jevNativeToolMaxCandidates))
    .map((item) => item.id);
  if (!selected.length) {
    return {
      ...baseline,
      candidateCount: candidates.candidates.length,
      fallbackReason: "no_selected_native_tool",
      telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
    };
  }
  const selectedSet = new Set(selected);
  for (const item of candidates.candidates) if (item.alwaysAvailable) selectedSet.add(item.slug);
  const routed = modelToolsForSelection(tools, selectedSet);
  return {
    tools: routed,
    source: "jev",
    candidateCount: candidates.candidates.length,
    selected: [...selectedSet],
    telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
  };
}

/**
 * Route native schemas without changing the existing behavior by default.
 * Jev proposes a bounded exposure set; execution remains in agent.ts and
 * nativeTools.ts, where account scope, argument validation, and approvals run.
 */
export async function routeNativeToolsForTurn(tools: ToolSchema[], query: string, options: {
  client?: JevClient;
  signal?: AbortSignal;
  recentContext?: string;
  sessionId?: string;
  deadline?: RoutingDeadline;
} = {}): Promise<NativeToolRoute> {
  const baseline = baselineRoute(tools);
  if (!query.trim() || !config.jevNativeToolRouting || !jevEnabled("native")) return baseline;
  const client = options.client ?? jevClient();
  if (!client.available()) return { ...baseline, fallbackReason: "jev_unavailable" };
  const mode = config.jevMode;
  const run = computeNativeToolRoute(query, tools, {
    ...options,
    client,
    signal: mode === "enforce" && options.deadline ? options.deadline.signal : options.signal,
  });
  const log = (route: NativeToolRoute | undefined, applied: boolean, reason?: string) => {
    const telemetry = route?.telemetry;
    recordDecision({
      surface: "native_tool",
      mode: mode === "enforce" ? "enforce" : "shadow",
      applied,
      ...(reason ? { fallbackReason: reason } : {}),
      ...(telemetry?.ranked ? { jev: telemetry.ranked.map((item) => ({ id: item.id, p: item.probability })) } : {}),
      baseline: baseline.selected.slice(0, 6),
      ...(telemetry ?? {}),
      model: client.modelId,
    });
  };
  if (mode === "shadow") {
    run.then((route) => log(route, false, route.fallbackReason ?? "shadow")).catch((error) => log(undefined, false, error instanceof Error ? error.name : "error"));
    return baseline;
  }
  const { value, failure } = await awaitRoute(run, options.deadline ? options.deadline.remaining() : config.jevTurnBudgetMs);
  if (!value || value.source !== "jev") {
    log(value, false, failure ?? value?.fallbackReason ?? "fallback");
    return { ...baseline, ...(failure ? { fallbackReason: failure } : value?.fallbackReason ? { fallbackReason: value.fallbackReason } : {}) };
  }
  log(value, true);
  return value;
}
