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
  | "monid"
  | "shopping"
  | "other";

export type NativeToolRisk = "read" | "write" | "high_impact";

export type NativeToolDescriptor = {
  slug: string;
  description: string;
  bundle: NativeToolBundle;
  risk: NativeToolRisk;
  alwaysAvailable: boolean;
  /** Compact capability terms used for pre-Jev candidate recall. */
  capabilities?: string[];
  /** Human/task aliases that may not appear in the stable tool slug. */
  aliases?: string[];
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

export type NativeToolSearchResult = Pick<NativeToolDescriptor, "slug" | "description" | "bundle" | "risk" | "capabilities" | "aliases">;

const CORE_TOOLS = new Set([
  "CHUCK_FIND_TOOLS",
  "CHUCK_TOOL_PREFLIGHT",
  "CHUCK_TOOL_RECOVERY",
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
  code: ["code", "computer", "daytona", "file", "folder", "sandbox", "workspace", "app", "build", "deploy", "terminal", "repository", "git"],
  autonomy: ["task", "mission", "reminder", "follow-up", "followup", "schedule", "delegate", "attention", "proactive", "loop", "lead", "leads", "prospect", "prospects", "campaign", "pipeline", "qualification"],
  monid: ["monid", "dataset", "census", "demographic", "weather", "forecast", "social", "market", "onchain", "chain", "blockchain", "business", "contact", "verified", "email", "target", "company", "local", "prospect", "enrichment", "partnership", "citation", "visibility", "youtube", "transcript", "creator", "outlier", "outperforming", "performance", "review", "reviews", "content", "seo", "keyword", "advertising", "advertiser", "ads", "scrape", "scraping", "crawl", "extract"],
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
  if (CORE_TOOLS.has(name)) return "core";
  // Call-control is intentionally not part of meeting preparation/search.
  // It remains discoverable for an explicit phone-call request, but must not
  // be exposed as an unrelated high-impact side effect during a meeting flow.
  if (name === "CHUCK_CONTROL_PHONE_CALL") return "other";
  if (/^CHUCK_TINYFISH_/.test(name)) return "tinyfish";
  if (/^CHUCK_(?:SAVE_MEMORY|UPDATE_MEMORY|SEARCH_MEMORY|FORGET_MEMORY|MEMORY_BRIEF|CONTEXT_SEARCH|SCRATCHPAD_)/.test(name)) return "memory";
  if (/^CHUCK_.*REMINDER/.test(name)) return "reminders";
  if (/^CHUCK_(?:BROWSER(?:_|$)|CAMOFOX_|VAULT_)/.test(name)) return "browser";
  if (/^CHUCK_MEETING_/.test(name) || /^CHUCK_(?:START_PHONE_CALL|LIST_PHONE_CALLS)$/.test(name)) return "meetings";
  if (/^CHUCK_(?:CREATE_(?:PDF|DOCUMENT|SPREADSHEET|PRESENTATION)|GENERATE_(?:IMAGE|VIDEO)|ARTIFACT(?:_|$)|IMAGE_ASSET_|DAYTONA_IMAGE$|EMAIL_ARTIFACT$|FILE_BRIDGE$|VIDEO_(?:STATUS|CANCEL)$)/.test(name)) return "artifacts";
  if (/^CHUCK_(?:MISSION_|TASK_|AUTONOMY_|ATTENTION_|.*SUBAGENT|HANDOFF_SUBAGENT|OUTCOME_)/.test(name) || /^CHUCK_(?:SCHEDULE_JOB|LIST_JOBS|RESUME_JOB|CANCEL_JOB|RUN_JOB_NOW|PAUSE_JOB)$/.test(name)) return "autonomy";
  if (/^CHUCK_LEAD_CAMPAIGN$/.test(name)) return "autonomy";
  if (/^CHUCK_(?:SHOPPING_|LINK_)/.test(name)) return "shopping";
  if (/^CHUCK_(?:DAYTONA_|COMPUTER(?:_|$))/.test(name)) return "code";
  if (/^CHUCK_MONID_/.test(name)) return "monid";
  if (/^CHUCK_TREG_/.test(name)) return "intelligence";
  if (/^CHUCK_(?:CONVERSATION_|.*TRIGGER|LIST_CONNECTED_ACCOUNTS|INTEGRATION_HEALTH)/.test(name)) return "workspace";
  const text = `${slug} ${description}`.toLowerCase();
  if (/treg|mcp|enrich|provider|seo|social|market|research/.test(text)) return "intelligence";
  if (/browser|vault|checkout|login|webpage|website/.test(text)) return "browser";
  if (/meeting|zoom|teams|webex|transcript|phone|call/.test(text)) return "meetings";
  if (/pdf|document|spreadsheet|presentation|artifact|image|video/.test(text)) return "artifacts";
  if (/computer|code|file|folder|sandbox|workspace|terminal|git|repository|\bapp\b/.test(text)) return "code";
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
  const slugTerms = words(slug.replace(/^CHUCK_/, "").replace(/_/g, " "));
  const capabilities = [...new Set([...BUNDLE_TERMS[bundle], ...slugTerms])].slice(0, 32);
  const aliases = [
    ...(bundle === "workspace" ? ["connected app", "integration", "saas"] : []),
    ...(bundle === "intelligence" || bundle === "monid" ? ["live data", "external data", "research"] : []),
    ...(bundle === "autonomy" ? ["durable work", "background task"] : []),
  ];
  return { slug, description, bundle, risk: inferRisk(slug), alwaysAvailable: CORE_TOOLS.has(slug), capabilities, aliases };
}

/**
 * Compact, model-facing metadata for every published native tool. Full JSON
 * schemas stay in agentTools.ts and are never sent to Jev.
 */
export const nativeToolManifest: NativeToolDescriptor[] = modelFacingChuckTools
  .map(descriptorFor)
  .filter((item): item is NativeToolDescriptor => Boolean(item));

/** A bounded capability card for Jev; full tool schemas stay in the runtime. */
export function nativeToolCapabilityCard(tool: NativeToolDescriptor): string {
  const capabilities = tool.capabilities?.length ? `; capabilities: ${tool.capabilities.slice(0, 18).join(", ")}` : "";
  const aliases = tool.aliases?.length ? `; aliases: ${tool.aliases.join(", ")}` : "";
  return `${tool.slug} (${tool.bundle}, ${tool.risk}${tool.alwaysAvailable ? ", always available" : ""}) — ${tool.description}${capabilities}${aliases}`.slice(0, 900);
}

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
  if (descriptor.slug === "CHUCK_LEAD_CAMPAIGN" && /\b(?:lead|leads|prospect|prospects|prospecting)\b/i.test(query)
    && /\b(?:find|build|generate|source|qualify|campaign|track|research)\b/i.test(query)) score += 100;
  if (descriptor.slug === "CHUCK_SET_REMINDER" && /\b(?:remind me|set (?:a )?reminder|schedule (?:a )?reminder)\b/i.test(query)) score += 100;
  // Prefer the purpose-built generator when the request names a concrete
  // document format. CHUCK_ARTIFACT owns lifecycle/registration, but should
  // not outrank the generator that creates the requested file.
  if (/\b(?:create|make|generate|produce|build|draft)\b/i.test(query)) {
    const formatByTool: Record<string, RegExp> = {
      CHUCK_CREATE_PDF: /\bpdf\b/i,
      CHUCK_CREATE_DOCUMENT: /\b(?:docx|word document|word file)\b/i,
      CHUCK_CREATE_PRESENTATION: /\b(?:pptx|powerpoint|presentation|slides?)\b/i,
      CHUCK_CREATE_SPREADSHEET: /\b(?:xlsx|excel|spreadsheet|workbook)\b/i,
    };
    if (formatByTool[descriptor.slug]?.test(query)) score += 100;
  }
  return score;
}

function inferredFamily(query: string): NativeToolBundle | undefined {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\bmonid\b/.test(normalized)) return "monid";
  if (/\btreg\b|\b(?:buying|buyer|purchase) intent signals?\b|\b(?:company|people|hiring|funding|technology adoption) signals?\b/.test(normalized)) return "intelligence";
  if (/\b(?:verified (?:work )?emails?|business contacts?|target companies|local (?:service )?(?:businesses|prospects?)|company enrichment|company brief|partnership (?:brief|meeting|research)|ai citation visibility|citation counts?|youtube (?:videos?|transcripts?)|video digest|video transcript|videos? (?:are )?outperforming|creator (?:outliers?|performance|baseline)|customer reviews?|review evidence|content opportunities|content improvements?|seo (?:pages?|content|keyword)|keyword (?:evidence|research)|(?:competitor )?ads? intelligence|ad library research|paid search footprint|public website extraction|website scraping research|public site crawl)\b/.test(normalized)) return "monid";
  if (/\btiny\s*fish\b|\btinyfish\b/.test(normalized)) return "tinyfish";
  if (/\b(?:lead|leads|prospect|prospects|campaign|pipeline|qualification)\b/.test(normalized)) return "autonomy";
  if (/\bmemories\b|\bmemory\b|\bscratchpad\b/.test(normalized)) return "memory";
  if (/\bremind(?:er|ers)?\b|\breminding\b|\bnotification\b|\bnotify\b/.test(normalized)) return "reminders";
  if (/\bbrowser\b|\bwebsite\b|\bwebpage\b|\bweb form\b/.test(normalized)) return "browser";
  if (/\bmeeting\b|\bmeetings\b|\bzoom call\b|\btranscript\b/.test(normalized)) return "meetings";
  if (/\bpdf\b|\bspreadsheet\b|\bexcel\b|\bpresentation\b|\bartifact\b|\bimage\b|\bvideo\b/.test(normalized)) return "artifacts";
  if (/\b(?:computer|daytona|file|files|folder|folders|sandbox|workspace|terminal|repository|git)\b/.test(normalized)) return "code";
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
  // Family discovery is still compact metadata, but it must be able to return
  // the complete family. The largest current family is 51 tools; 64 leaves
  // room for growth without allowing an unbounded schema dump.
  const defaultLimit = family ? 64 : 10;
  const bounded = Math.max(1, Math.min(64, Math.floor(limit ?? defaultLimit) || defaultLimit));
  const entries = nativeToolManifest
    .filter((item) => !family || item.bundle === family)
    .filter((item) => !allowed || allowed.has(item.slug))
    .map((item) => ({ item, score: relevance(queryText, item) }))
    // Explicit family discovery is an inventory request: return the whole
    // family instead of requiring each tool to win a lexical score.
    .filter((entry) => family || !queryText || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
    .slice(0, bounded)
    .map(({ item }) => ({ slug: item.slug, description: item.description, bundle: item.bundle, risk: item.risk, capabilities: item.capabilities, aliases: item.aliases }));
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
  const defaultLimit = family ? 64 : 20;
  const bounded = Math.max(1, Math.min(64, Math.floor(limit ?? defaultLimit) || defaultLimit));
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

/**
 * Apply a multi-label Jev result that was already obtained in a turn-wide
 * batch. This keeps the model-facing catalog reduction and lifecycle closure
 * identical to the standalone native router without making another request.
 */
export function nativeToolRouteFromJevScores(tools: ToolSchema[], input: {
  scores: Record<string, number>;
  candidateCount?: number;
  query: string;
  recentContext?: string;
  preserveAll?: boolean;
  latencyMs?: number;
  costUsd?: number;
}): NativeToolRoute {
  const baseline = baselineRoute(tools);
  const ranked = Object.entries(input.scores)
    .filter(([id, value]) => descriptorBySlug.has(id) && Number.isFinite(value))
    .map(([id, probability]) => ({ id, probability: Math.max(0, Math.min(1, probability)) }))
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const telemetry = {
    latencyMs: input.latencyMs ?? 0,
    costUsd: input.costUsd ?? 0,
    ranked,
  };
  const best = ranked[0];
  if (!best || best.probability < config.jevNativeToolMinProbability) {
    const fallbackReason = "jev_no_native_tool_needed";
    const fallback = config.nativeToolLoading === "bundle" && !input.preserveAll
      ? bundleFallbackRoute(tools, input.query, fallbackReason)
      : baseline;
    return {
      ...fallback,
      candidateCount: input.candidateCount ?? ranked.length,
      noNativeTool: true,
      noNativeToolConfidence: 1 - (best?.probability ?? 0),
      telemetry,
    };
  }

  const selected = ranked
    .filter((item) => item.probability >= config.jevNativeToolMinProbability)
    .slice(0, config.jevNativeToolMaxCandidates)
    .map((item) => item.id);
  if (!selected.length) {
    const fallbackReason = "jev_no_selected_native_tool";
    return {
      ...(config.nativeToolLoading === "bundle" && !input.preserveAll ? bundleFallbackRoute(tools, input.query, fallbackReason) : baseline),
      candidateCount: input.candidateCount ?? ranked.length,
      fallbackReason,
      telemetry,
    };
  }

  const selectedSet = new Set(selected);
  for (const item of nativeToolManifest) if (item.alwaysAvailable) selectedSet.add(item.slug);
  retainLifecycleToolFamilies(tools, selectedSet, input.query, input.recentContext);
  return {
    tools: modelToolsForSelection(tools, selectedSet),
    source: "jev",
    candidateCount: input.candidateCount ?? ranked.length,
    selected: [...selectedSet],
    telemetry,
  };
}

/** Add a separately routed native family without reopening a Jev request. */
export function augmentNativeToolRoute(tools: ToolSchema[], route: NativeToolRoute, slugs: string[]): NativeToolRoute {
  const additions = new Set(slugs.filter((slug) => descriptorBySlug.has(slug)));
  if (!additions.size) return route;
  const existing = new Set(route.tools.map(toolName));
  return {
    ...route,
    tools: [...route.tools, ...tools.filter((tool) => additions.has(toolName(tool)) && !existing.has(toolName(tool)))],
    selected: [...new Set([...route.selected, ...additions])],
    noNativeTool: false,
    noNativeToolConfidence: undefined,
  };
}

/**
 * A supported meeting URL plus an explicit participation request is a
 * deterministic meeting operation. It must not be treated as a generic web
 * browsing task, including when the current turn says only "join it" and the
 * URL is present in recent thread context.
 */
export function isDirectMeetingJoinRequest(query: string): boolean {
  const hasSupportedMeetingUrl = /https?:\/\/(?:meet\.google\.com|(?:[a-z0-9-]+\.)?zoom\.us|(?:[a-z0-9-]+\.)?teams\.microsoft\.com|(?:[a-z0-9-]+\.)?webex\.com)\b/i.test(query);
  const asksToParticipate = /\b(?:join|attend|enter|participate|listen|sit\s+in|summari[sz]e|how\s+(?:did|was)\s+the\s+meeting|what(?:'s|\s+is)\s+happening)\b/i.test(query);
  return hasSupportedMeetingUrl && asksToParticipate;
}

/**
 * Keep direct meeting joins on the dedicated meeting surface. Browser and
 * computer tools are intentionally removed for this request so a model cannot
 * silently replace a real meeting participant with an unrelated private
 * browser session. This changes exposure only; the native execution policy and
 * Recall/provider checks still decide whether the join can actually happen.
 */
export function enforceDirectMeetingJoinRoute(tools: ToolSchema[], route: NativeToolRoute, query: string): NativeToolRoute {
  if (!isDirectMeetingJoinRequest(query)) return route;
  const isGenericBrowser = (slug: string): boolean => /^CHUCK_(?:BROWSER(?:_|$)|VAULT_|DAYTONA_COMPUTER(?:_|$))/.test(slug);
  const filtered = route.tools.filter((tool) => !isGenericBrowser(toolName(tool)));
  const meetingJoin = tools.find((tool) => toolName(tool) === "CHUCK_MEETING_JOIN");
  if (meetingJoin && !filtered.some((tool) => toolName(tool) === "CHUCK_MEETING_JOIN")) filtered.push(meetingJoin);
  const selected = route.selected.filter((slug) => !isGenericBrowser(slug));
  if (meetingJoin) selected.push("CHUCK_MEETING_JOIN");
  return {
    ...route,
    tools: filtered.filter((tool, index, all) => all.findIndex((candidate) => toolName(candidate) === toolName(tool)) === index),
    selected: [...new Set(selected)],
    ...(meetingJoin ? { noNativeTool: false, noNativeToolConfidence: undefined } : {}),
  };
}

function nativeToolCount(tools: ToolSchema[]): number {
  return tools.reduce((count, tool) => count + (descriptorBySlug.has(toolName(tool)) ? 1 : 0), 0);
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
  if (!candidates.matched || candidates.candidates.length < 2) {
    return noNativeToolRoute(tools, "no_native_candidate_set", 1, config.nativeToolLoading === "bundle" && !options.preserveAll);
  }
  const client = options.client ?? jevClient();
  const state = {
    request: jevText(query, 3_000),
    ...(options.recentContext ? { recent_conversation: jevText(options.recentContext, 1_200) } : {}),
  };
  const ranking = await rankOptions(client, {
    state,
    instructions: "Which native Chusky tools should be exposed to the main agent to complete this request? Select tools whose described operation is necessary or a plausible next step for the stated outcome; exclude general-purpose tools that are merely capable. Choose __none__ if none directly applies. This controls availability only; the main agent and runtime still validate arguments, scope, and approval.",
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
    .slice(0, config.jevNativeToolMaxCandidates)
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
  if (!client.available()) return config.nativeToolLoading === "bundle" && !options.preserveAll
    ? bundleFallbackRoute(tools, query, "bundle_jev_unavailable")
    : { ...baseline, fallbackReason: "jev_unavailable" };
  const mode = config.jevMode;
  const run = computeNativeToolRoute(query, tools, {
    ...options,
    client,
    signal: mode === "enforce" && options.deadline ? options.deadline.signal : options.signal,
  });
  const log = (route: NativeToolRoute | undefined, applied: boolean, reason?: string) => {
    const telemetry = route?.telemetry;
    const baselineNativeTools = nativeToolCount(tools);
    const exposedNativeTools = route ? nativeToolCount(route.tools) : undefined;
    const reducedBundleApplied = Boolean(
      route
      && config.nativeToolLoading === "bundle"
      && !options.preserveAll
      && exposedNativeTools !== undefined
      && exposedNativeTools < baselineNativeTools,
    );
    recordDecision({
      surface: "native_tool",
      mode: mode === "enforce" ? "enforce" : "shadow",
      // `applied` means the model-facing native schema set was actually
      // changed. A Jev response alone is not enough: bundle mode must reduce
      // the native catalog or use a bounded fallback.
      applied: applied && (config.nativeToolLoading !== "bundle" || options.preserveAll === true || reducedBundleApplied),
      ...(reason ? { fallbackReason: reason } : {}),
      ...(telemetry?.ranked ? { jev: telemetry.ranked.map((item) => ({ id: item.id, p: item.probability })) } : {}),
      baseline: baseline.selected.slice(0, 6),
      ...(telemetry ?? {}),
      model: client.modelId,
      routeSource: route?.source,
      exposedTools: route?.tools.length,
      baselineTools: tools.length,
      ...(baselineNativeTools ? { exposedNativeTools, baselineNativeTools } : {}),
      loading: config.nativeToolLoading,
      noNativeTool: route?.noNativeTool,
      preserveAll: options.preserveAll === true,
    });
  };
  if (mode === "shadow") {
    run.then((route) => log(route, false, route.fallbackReason ?? "shadow")).catch((error) => log(undefined, false, error instanceof Error ? error.name : "error"));
    // Shadow mode may keep Jev advisory, but it must not reopen the entire
    // native catalog when production bundle loading is enabled. Use the same
    // deterministic objective bundle that the off/unavailable paths use.
    return baseline;
  }
  const { value, failure } = await awaitRoute(run, options.deadline ? options.deadline.remaining() : config.jevTurnBudgetMs);
  if (!value || value.source !== "jev") {
    const fallback = enforceDirectMeetingJoinRoute(tools, value ?? (config.nativeToolLoading === "bundle" && !options.preserveAll
      ? bundleFallbackRoute(tools, query, "bundle_route_failure")
      : { ...baseline, ...(failure ? { fallbackReason: failure } : {}) }), query);
    log(fallback, false, failure ?? fallback.fallbackReason ?? "fallback");
    return fallback;
  }
  if (config.nativeToolLoading === "bundle" && !options.preserveAll) {
    const baselineNativeTools = nativeToolCount(tools);
    const exposedNativeTools = nativeToolCount(value.tools);
    if (exposedNativeTools >= baselineNativeTools) {
      const fallback = enforceDirectMeetingJoinRoute(tools, bundleFallbackRoute(tools, query, "jev_route_not_reduced"), query);
      log(fallback, false, "jev_route_not_reduced");
      return fallback;
    }
  }
  const guarded = enforceDirectMeetingJoinRoute(tools, value, query);
  log(guarded, true);
  return guarded;
}
