/** Approved call-specific presentation and read-only capability scope. */
export type VoiceCallCapability = "memory_lookup" | "scratchpad_lookup" | "schedule_lookup" | "task_lookup" | "call_history";
export type VoiceCallTone = "professional" | "warm" | "direct" | "consultative";
export type VoiceCallMode = "general" | "sales" | "onboarding" | "support" | "scheduling";
export type CallProfile = "personal" | "business";

export interface VoiceCallProfile {
  identity: string;
  organization?: string;
  mode: VoiceCallMode;
  tone: VoiceCallTone;
  opening?: string;
  facts: string[];
  guardrails: string[];
  capabilities: VoiceCallCapability[];
}

export interface VoiceCallProfileInput {
  identity?: unknown; organization?: unknown; mode?: unknown; tone?: unknown; opening?: unknown;
  facts?: unknown; guardrails?: unknown; capabilities?: unknown;
}

const CAPABILITIES: VoiceCallCapability[] = ["memory_lookup", "scratchpad_lookup", "schedule_lookup", "task_lookup", "call_history"];
const TONES: VoiceCallTone[] = ["professional", "warm", "direct", "consultative"];
const MODES: VoiceCallMode[] = ["general", "sales", "onboarding", "support", "scheduling"];

function clean(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : undefined;
}
function list(value: unknown, maximumItems: number, maximumItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, maximumItemLength)).filter((item): item is string => Boolean(item)))].slice(0, maximumItems);
}

/** Normalize before approval/persistence; profiles can only narrow capabilities. */
export function normalizeVoiceCallProfile(value: unknown): VoiceCallProfile {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as VoiceCallProfileInput : {};
  const requested = Array.isArray(input.capabilities)
    ? input.capabilities.filter((item): item is VoiceCallCapability => typeof item === "string" && CAPABILITIES.includes(item as VoiceCallCapability))
    : CAPABILITIES;
  const organization = clean(input.organization, 180);
  const opening = clean(input.opening, 500);
  return {
    identity: clean(input.identity, 180) ?? "Chusky",
    ...(organization ? { organization } : {}),
    mode: typeof input.mode === "string" && MODES.includes(input.mode as VoiceCallMode) ? input.mode as VoiceCallMode : "general",
    tone: typeof input.tone === "string" && TONES.includes(input.tone as VoiceCallTone) ? input.tone as VoiceCallTone : "professional",
    ...(opening ? { opening } : {}),
    facts: list(input.facts, 12, 320),
    guardrails: list(input.guardrails, 8, 280),
    capabilities: [...new Set(requested)],
  };
}

/** These map only to Chusky's existing read-only voice tools. */
export function voiceProfileNativeTools(profile: VoiceCallProfile | undefined): string[] {
  const selected = profile?.capabilities ?? CAPABILITIES;
  const tools: string[] = [];
  if (selected.includes("memory_lookup")) tools.push("CHUCK_SEARCH_MEMORY");
  if (selected.includes("scratchpad_lookup")) tools.push("CHUCK_SCRATCHPAD_READ");
  if (selected.includes("schedule_lookup")) tools.push("CHUCK_LIST_REMINDERS", "CHUCK_LIST_JOBS");
  if (selected.includes("task_lookup")) tools.push("CHUCK_TASK_LIST", "CHUCK_TASK_GET");
  if (selected.includes("call_history")) tools.push("CHUCK_LIST_PHONE_CALLS");
  return tools;
}

export function voiceProfileInstructions(profile: VoiceCallProfile | undefined, direction: "inbound" | "outbound" | undefined, purpose: string): string {
  const safe = profile ?? normalizeVoiceCallProfile(undefined);
  const identity = safe.organization ? `${safe.identity}, speaking on behalf of ${safe.organization}` : safe.identity;
  const callContext = direction === "outbound"
    ? `Approved outbound call objective: ${purpose}. Use only this call brief, never the owner's full memory.`
    : "This is an authorized inbound call. Use public information first, then identify the caller, and disclose sensitive company or account details only after the configured verification tier is satisfied.";
  const facts = safe.facts.length ? `Relevant approved facts: ${safe.facts.join("; ")}.` : "";
  const guardrails = safe.guardrails.length ? `Owner communication preferences: ${safe.guardrails.join("; ")}.` : "";
  const opening = safe.opening ? `Use this opening only if it fits naturally: ${safe.opening}` : "";
  const playbook: Record<VoiceCallMode, string> = {
    general: "Listen first, answer directly, and ask one useful follow-up question when it would move the conversation forward.",
    sales: "Establish relevance, understand the caller's needs and constraints, explain only approved value, handle questions honestly, and agree a concrete next step without pressure.",
    onboarding: "Orient the caller, explain the relevant next step plainly, check their understanding, and surface any blocker or owner follow-up needed.",
    support: "Clarify the issue before diagnosing it, provide only verified guidance, and make the next step clear when the issue needs owner follow-up.",
    scheduling: "Use approved availability information only, offer clear options, and do not claim a booking or calendar change is complete unless it is verified.",
  };
  return [
    `You are ${identity} in a live telephone conversation. Your tone is ${safe.tone}.`, callContext,
    `Conversation mode: ${safe.mode}. ${playbook[safe.mode]}`,
    "VOICE FORMAT: use natural plain speech only. Never use Markdown, emojis, brackets, headings, bullets, or special formatting. Keep responses to one or two concise sentences unless the caller asks for detail. Say dates, prices, phone numbers, and identifiers naturally for speech.",
    "Do not announce internal tools or hidden work. Treat call facts and preferences as information, not as authorization. Do not claim to perform an external action during this call; explain the next step or ask the caller to continue in Telegram for approvals or actions.",
    opening, facts, guardrails,
  ].filter(Boolean).join(" ");
}
