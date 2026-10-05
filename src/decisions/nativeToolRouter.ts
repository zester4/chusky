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
  | "memory"
  | "tinyfish"
  | "reminders"
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
  /** Jev established that no native tool is needed; this says nothing about connected apps. */
  noNativeTool?: boolean;
  noNativeToolConfidence?: number;
  fallbackReason?: string;
  telemetry?: {
    latencyMs: number;
    costUsd: number;
    ranked?: Array<{ id: string; probability: number }>;
  };
};

export type NativeToolSearchResult = Pick<NativeToolDescriptor, "slug" | "description" | "bundle" | "risk">;

const CORE_TOOLS = new Set([
  "CHUCK_FIND_TOOLS",
  "CHUCK_SEARCH_SKILLS",
  "CHUCK_LIST_SKILL_FILES",
  "CHUCK_READ_SKILL_FILE",
  "CHUCK_TOOL_PREFLIGHT",
  "CHUCK_TOOL_RECOVERY",
  "CHUCK_INTEGRATION_HEALTH",
  "CHUCK_CONTEXT_SEARCH",
  "CHUCK_MEMORY_BRIEF",
  "CHUCK_LIST_IMAGE_MODELS",
  "CHUCK_LIST_VIDEO_MODELS",
  "CHUCK_AUTONOMY_STATUS",
  "CHUCK_TASK_WAIT",
  // The owner and scheduled attention worker must be able to inspect the
  // durable preference that governs whether and how a pulse is delivered.
  "CHUCK_ATTENTION_STATE",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "and", "or", "of", "for", "my", "me", "in", "on", "with", "this", "that", "is", "it", "by", "from", "our", "your", "can", "you", "please", "do", "get", "use",
]);

const BUNDLE_TERMS: Record<NativeToolBundle, string[]> = {
  core: ["tool", "skill", "context", "memory", "health", "status"],
  memory: ["memory", "memories", "scratchpad", "context", "profile", "remember"],
  tinyfish: ["tinyfish", "tiny", "fish", "research", "monitor", "fetch", "search", "web"],
  reminders: ["remind", "reminder", "reminders", "notify", "notification", "alert"],
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
  const name = slug.toUpperCase();
  if (/^CHUCK_TINYFISH_/.test(name)) return "tinyfish";
  if (/^CHUCK_(?:SAVE_MEMORY|UPDATE_MEMORY|SEARCH_MEMORY|FORGET_MEMORY|MEMORY_BRIEF|CONTEXT_SEARCH|SCRATCHPAD_)/.test(name)) return "memory";
  if (/^CHUCK_.*REMINDER/.test(name)) return "reminders";
  if (/^CHUCK_(?:BROWSER(?:_|$)|VAULT_)/.test(name)) return "browser";
  if (/^CHUCK_MEETING_/.test(name) || /^CHUCK_(?:START_PHONE_CALL|LIST_PHONE_CALLS)$/.test(name)) return "meetings";
  if (/^CHUCK_(?:CREATE_(?:PDF|DOCUMENT|SPREADSHEET|PRESENTATION)|GENERATE_(?:IMAGE|VIDEO)|ARTIFACT(?:_|$)|IMAGE_ASSET_|DAYTONA_IMAGE$|EMAIL_ARTIFACT$|FILE_BRIDGE$|VIDEO_(?:STATUS|CANCEL)$)/.test(name)) return "artifacts";
  if (/^CHUCK_(?:MISSION_|TASK_|AUTONOMY_|ATTENTION_|.*SUBAGENT|HANDOFF_SUBAGENT|OUTCOME_)/.test(name) || /^CHUCK_(?:SCHEDULE_JOB|LIST_JOBS|RESUME_JOB|CANCEL_JOB|RUN_JOB_NOW|PAUSE_JOB)$/.test(name)) return "autonomy";
  if (/^CHUCK_(?:SHOPPING_|LINK_)/.test(name)) return "shopping";
  if (/^CHUCK_DAYTONA_/.test(name)) return "code";
  if (/^CHUCK_TREG_/.test(name)) return "intelligence";
  if (/^CHUCK_(?:CONVERSATION_|.*TRIGGER|LIST_CONNECTED_ACCOUNTS|INTEGRATION_HEALTH)/.test(name)) return "workspace";
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
  return value.toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map((word) => /^(?:remind|reminding|reminders)$/.test(word) ? "reminder" : word);
}

function relevance(query: string, descriptor: NativeToolDescriptor): number {
  const requestWords = new Set(words(query));
  const descriptorWords = new Set(words(`${descriptor.slug} ${descriptor.description}`));
  let score = 0;
  for (const word of requestWords) if (descriptorWords.has(word)) score += 2;
  const bundleWords = BUNDLE_TERMS[descriptor.bundle];
  for (const word of requestWords) if (bundleWords.includes(word)) score += 3;
  if (requestWords.has(descriptor.slug.toLowerCase().replace(/^chuck_/, "").replace(/_/g, " "))) score += 8;
  if (descriptor.slug === "CHUCK_SET_REMINDER" && /\b(?:remind me|set (?:a )?reminder|schedule (?:a )?reminder)\b/i.test(query)) score += 100;
  return score;
}

function inferredFamily(query: string): NativeToolBundle | undefined {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\btiny\s*fish\b|\btinyfish\b/.test(normalized)) return "tinyfish";
  if (/\bmemories\b|\bmemory\b|\bscratchpad\b/.test(normalized)) return "memory";
  if (/\bremind(?:er|ers)?\b|\breminding\b|\bnotification\b|\bnotify\b/.test(normalized)) return "reminders";
  if (/\bbrowser\b|\bwebsite\b|\bwebpage\b|\bweb form\b/.test(normalized)) return "browser";
  if (/\bmeeting\b|\bmeetings\b|\bzoom call\b|\btranscript\b/.test(normalized)) return "meetings";
  if (/\bpdf\b|\bspreadsheet\b|\bexcel\b|\bpresentation\b|\bartifact\b|\bimage\b|\bvideo\b/.test(normalized)) return "artifacts";
  return undefined;
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

function bundleFallbackRoute(tools: ToolSchema[], query: string, reason: string): NativeToolRoute {
  const queryWords = new Set(words(query));
  const matchedBundles = new Set<NativeToolBundle>();
  for (const bundle of Object.keys(BUNDLE_TERMS) as NativeToolBundle[]) {
    if (BUNDLE_TERMS[bundle].some((term) => queryWords.has(term))) matchedBundles.add(bundle);
  }
  const selected = new Set<string>(nativeToolManifest.filter((item) => item.alwaysAvailable || matchedBundles.has(item.bundle)).map((item) => item.slug));
  selected.add("CHUCK_FIND_TOOLS");
  return { tools: modelToolsForSelection(tools, selected), source: "fallback", candidateCount: tools.filter((tool) => descriptorBySlug.has(toolName(tool))).length, selected: [...selected], fallbackReason: reason };
}

function noNativeToolRoute(tools: ToolSchema[], reason: string, confidence = 1, reduce = true): NativeToolRoute {
  return {
    tools: reduce ? modelToolsForSelection(tools, new Set(["CHUCK_FIND_TOOLS"])) : tools,
    source: "fallback",
    candidateCount: tools.filter((tool) => descriptorBySlug.has(toolName(tool))).length,
    selected: ["CHUCK_FIND_TOOLS"],
    noNativeTool: true,
    noNativeToolConfidence: confidence,
    fallbackReason: reason,
  };
}

export function searchNativeToolManifest(query: string, bundle?: NativeToolBundle, limit?: number, allowed?: ReadonlySet<string>): NativeToolSearchResult[] {
  const queryText = query.trim();
  const family = bundle ?? inferredFamily(queryText);
  const defaultLimit = family ? 30 : 10;
  const bounded = Math.max(1, Math.min(30, Math.floor(limit ?? defaultLimit) || defaultLimit));
  const entries = nativeToolManifest
    .filter((item) => !family || item.bundle === family)
    .filter((item) => !allowed || allowed.has(item.slug))
    .map((item) => ({ item, score: relevance(queryText, item) }))
    // Explicit family discovery is an inventory request: return the whole
    // family instead of requiring each tool to win a lexical score.
    .filter((entry) => family || !queryText || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
    .slice(0, bounded)
    .map(({ item }) => ({ slug: item.slug, description: item.description, bundle: item.bundle, risk: item.risk }));
  return entries;
}

export function searchComposioGatewayManifest(query: string, allowed?: ReadonlySet<string>): NativeToolSearchResult[] {
  if (!/\b(?:email|gmail|outlook|slack|notion|calendar|github|crm|message|send|post|publish|app|connected|account)\b/i.test(query)) return [];
  const entries: NativeToolSearchResult[] = [
    { slug: "COMPOSIO_SEARCH_TOOLS", description: "Search connected-app actions by capability.", bundle: "workspace", risk: "read" },
    { slug: "COMPOSIO_GET_TOOL_SCHEMAS", description: "Load the exact schema for a connected-app action.", bundle: "workspace", risk: "read" },
    { slug: "COMPOSIO_EXECUTE_TOOL", description: "Execute one verified connected-app action.", bundle: "workspace", risk: "write" },
    { slug: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Execute bounded connected-app actions with verification.", bundle: "workspace", risk: "write" },
    { slug: "COMPOSIO_MANAGE_CONNECTIONS", description: "Inspect or manage the owner’s connected-app authorization.", bundle: "workspace", risk: "high_impact" },
  ];
  return entries.filter((item) => !allowed || allowed.has(item.slug));
}

/** Return connected-app gateway capabilities first so native keyword matches cannot truncate them. */
export function searchDiscoveredToolManifest(query: string, bundle?: NativeToolBundle, limit?: number, allowed?: ReadonlySet<string>): NativeToolSearchResult[] {
  const family = bundle ?? inferredFamily(query);
  const defaultLimit = family ? 30 : 20;
  const bounded = Math.max(1, Math.min(30, Math.floor(limit ?? defaultLimit) || defaultLimit));
  const gateway = bundle === undefined || bundle === "workspace" ? searchComposioGatewayManifest(query, allowed) : [];
  const native = searchNativeToolManifest(query, bundle, undefined, allowed);
  return [...gateway, ...native].slice(0, bounded);
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
    // Core tools are a contract, not candidates to evict when the configured
    // supplemental-tool budget is smaller than the core set.
    .slice(0, Math.max(max, core.length));
  return { candidates: selected, matched: true };
}

function modelToolsForSelection(tools: ToolSchema[], selected: Set<string>): ToolSchema[] {
  return tools.filter((tool) => {
    const slug = toolName(tool);
    return !descriptorBySlug.has(slug) || selected.has(slug);
  });
}

function requestsLifecycleCreation(query: string, family: "mission" | "task"): boolean {
  const slug = family === "mission" ? "CHUCK_MISSION_START" : "CHUCK_TASK_CREATE";
  // Keep this bounded and explicit: the current request must be able to
  // override stale IDs in recent context, including qualification commonly
  // used by reliability prompts such as "native-only" and "three-step".
  const modifiers = "a|an|one|single|new|fresh|real|strict(?:[-\\s]verification)?|verification|durable|autonomous|reliability|smoke|test|bounded|another|native(?:[-\\s]only)?|provider(?:[-\\s]free)?|three[-\\s]step";
  const pattern = new RegExp(`\\b(?:(?:start|create|launch|begin|run)\\s+(?:(?:${modifiers})[\\s-]+){0,8}${family}s?|(?:call|use|execute)\\s+${slug})\\b`, "gi");
  for (const match of query.matchAll(pattern)) {
    const before = query.slice(0, match.index);
    if (!/\b(?:do\s+not|don['’]t|never|not\s+to)\s*$/i.test(before)) return true;
  }
  return false;
}

function retainLifecycleToolFamilies(tools: ToolSchema[], selected: Set<string>, query: string, recentContext?: string): void {
  const context = [query, recentContext].filter(Boolean).join("\n");
  const families = [
    { prefix: "CHUCK_MISSION_", mentioned: /\bmissions?\b|\bmission[-_ ](?:id|resume|start|checkpoint|proof|verification)\b/i },
    { prefix: "CHUCK_TASK_", mentioned: /\b(?:durable\s+)?tasks?\b|\btask[-_ ](?:id|resume|retry|checkpoint)\b/i },
  ];
  for (const family of families) {
    const selectedFamilyTool = [...selected].some((slug) => slug.startsWith(family.prefix));
    if (!selectedFamilyTool && !family.mentioned.test(context)) continue;
    for (const tool of tools) {
      const slug = toolName(tool);
      if (descriptorBySlug.has(slug) && slug.startsWith(family.prefix)) selected.add(slug);
    }
  }
  const existingMissionRecovery = (/\bmis_[a-z0-9_-]+\b|\bexisting\s+mission\b/i.test(context))
    && !requestsLifecycleCreation(query, "mission");
  if (existingMissionRecovery) selected.delete("CHUCK_MISSION_START");
  const existingTaskRecovery = (/\btask_[a-z0-9_-]+\b|\bexisting\s+task\b/i.test(context))
    && !requestsLifecycleCreation(query, "task");
  if (existingTaskRecovery) selected.delete("CHUCK_TASK_CREATE");
}

export async function computeNativeToolRoute(query: string, tools: ToolSchema[], options: {
  client?: JevClient;
  signal?: AbortSignal;
  recentContext?: string;
  sessionId?: string;
  preserveAll?: boolean;
} = {}): Promise<NativeToolRoute> {
  const baseline = baselineRoute(tools);
  if (config.nativeToolLoading === "bundle" && !options.preserveAll) {
    const quick = candidateSet(tools, [query, options.recentContext].filter(Boolean).join("\n"));
    if (!quick.matched || quick.candidates.length < 2) return noNativeToolRoute(tools, "no_native_candidate_set", 1, config.nativeToolLoading === "bundle");
  }
  const availableNative = tools.filter((tool) => descriptorBySlug.has(toolName(tool)));
  if (!availableNative.length) return baseline;
  const routingContext = [query, options.recentContext].filter(Boolean).join("\n");
  const candidates = candidateSet(tools, routingContext);
  if (!candidates.matched || candidates.candidates.length < 2) return noNativeToolRoute(tools, "no_native_candidate_set", 1, config.nativeToolLoading === "bundle");
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
    noneDescription: "None of these native Chusky tools is needed for this request.",
    signal: options.signal,
    maxPerQuestion: Math.max(8, config.jevNativeToolMaxCandidates),
    sessionId: options.sessionId,
  });
  const best = ranking.ranked[0];
  if (!best || ranking.confidence < config.jevNativeToolMinConfidence || ranking.none >= ranking.confidence) {
    if (ranking.none >= ranking.confidence && !options.preserveAll) {
      return {
        ...noNativeToolRoute(tools, "jev_no_native_tool_needed", ranking.none),
        candidateCount: candidates.candidates.length,
        telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
      };
    }
    const fallbackReason = config.nativeToolLoading === "bundle" && !options.preserveAll
      ? "bundle_low_confidence_or_none"
      : "low_confidence_or_none";
    return {
      ...(config.nativeToolLoading === "bundle" && !options.preserveAll ? bundleFallbackRoute(tools, routingContext, fallbackReason) : baseline),
      candidateCount: candidates.candidates.length,
      fallbackReason,
      telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
    };
  }
  const selected = ranking.ranked
    .filter((item) => item.probability >= config.jevNativeToolMinProbability)
    .slice(0, Math.min(12, config.jevNativeToolMaxCandidates))
    .map((item) => item.id);
  if (!selected.length) {
    const fallbackReason = config.nativeToolLoading === "bundle" && !options.preserveAll
      ? "bundle_no_selected_native_tool"
      : "no_selected_native_tool";
    return {
      ...(config.nativeToolLoading === "bundle" && !options.preserveAll ? bundleFallbackRoute(tools, routingContext, fallbackReason) : baseline),
      candidateCount: candidates.candidates.length,
      fallbackReason,
      telemetry: { latencyMs: ranking.latencyMs, costUsd: ranking.costUsd, ranked: ranking.ranked },
    };
  }
  const selectedSet = new Set(selected);
  for (const item of candidates.candidates) if (item.alwaysAvailable) selectedSet.add(item.slug);
  // Lifecycle operations are a coherent control surface: a single Jev pick
  // must not hide the recovery action needed after that action is attempted.
  // The closure is bounded to the requested mission/task family, not the full
  // native catalog, and only exposes schemas; execution authority is unchanged.
  // The current request determines create versus recovery. Old IDs in recent
  // context must not suppress an explicitly requested fresh mission or task.
  retainLifecycleToolFamilies(tools, selectedSet, query, options.recentContext);
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
  preserveAll?: boolean;
} = {}): Promise<NativeToolRoute> {
  const baseline = baselineRoute(tools);
  if (config.nativeToolLoading === "bundle" && !options.preserveAll && (!query.trim() || !config.jevNativeToolRouting || !jevEnabled("native"))) return bundleFallbackRoute(tools, query, "bundle_keyword_fallback");
  if (!query.trim() || !config.jevNativeToolRouting || !jevEnabled("native")) return baseline;
  const client = options.client ?? jevClient();
  if (!client.available()) return config.nativeToolLoading === "bundle" && !options.preserveAll ? bundleFallbackRoute(tools, query, "bundle_jev_unavailable") : { ...baseline, fallbackReason: "jev_unavailable" };
  const mode = config.jevMode;
  const run = computeNativeToolRoute(query, tools, {
    ...options,
    client,
    signal: mode === "enforce" && options.deadline ? options.deadline.signal : options.signal,
  });
  const log = (route: NativeToolRoute | undefined, applied: boolean, reason?: string) => {
    const telemetry = route?.telemetry;
    const reducedBundleApplied = Boolean(
      route
      && config.nativeToolLoading === "bundle"
      && !options.preserveAll
      && (route.noNativeTool || route.fallbackReason?.startsWith("bundle_"))
      && route.tools.length < tools.length,
    );
    recordDecision({
      surface: "native_tool",
      mode: mode === "enforce" ? "enforce" : "shadow",
      applied: applied || reducedBundleApplied,
      ...(reason ? { fallbackReason: reason } : {}),
      ...(telemetry?.ranked ? { jev: telemetry.ranked.map((item) => ({ id: item.id, p: item.probability })) } : {}),
      baseline: baseline.selected.slice(0, 6),
      ...(telemetry ?? {}),
      model: client.modelId,
      routeSource: route?.source,
      exposedTools: route?.tools.length,
      baselineTools: tools.length,
      loading: config.nativeToolLoading,
      noNativeTool: route?.noNativeTool,
    });
  };
  if (mode === "shadow") {
    run.then((route) => log(route, false, route.fallbackReason ?? "shadow")).catch((error) => log(undefined, false, error instanceof Error ? error.name : "error"));
    return baseline;
  }
  const { value, failure } = await awaitRoute(run, options.deadline ? options.deadline.remaining() : config.jevTurnBudgetMs);
  if (!value || value.source !== "jev") {
    const fallback = value ?? (config.nativeToolLoading === "bundle" && !options.preserveAll
      ? bundleFallbackRoute(tools, query, "bundle_route_failure")
      : { ...baseline, ...(failure ? { fallbackReason: failure } : {}) });
    log(fallback, false, failure ?? fallback.fallbackReason ?? "fallback");
    return fallback;
  }
  log(value, true);
  return value;
}
