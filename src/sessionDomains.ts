import type { ImageAsset, MemoryFact, Message, SdkFileRecord, SdkThreadRecord, ArtifactRecord, UserSession } from "./store.js";
import { DURABLE_SESSION_DOMAINS, type DurableSessionDomain } from "./neonDurableState.js";

export const DURABLE_SESSION_FORMAT = 1;
export const HOT_CONVERSATION_MESSAGES = 20;

export type DurableSessionPayloads = Map<DurableSessionDomain, unknown>;

type SessionWithDurableMarker = UserSession & { durableSessionFormat?: number };

export function sessionUsesNeonDomains(session: UserSession): boolean {
  return (session as SessionWithDurableMarker).durableSessionFormat === DURABLE_SESSION_FORMAT;
}

/** Separate high-growth fields without changing the UserSession API used by callers. */
export function splitSessionDomains(session: UserSession, separateSdkRuns = false): { core: UserSession; domains: DurableSessionPayloads; sdkRuns: Array<{ threadId: string; run: SdkThreadRecord["runs"][number] }> } {
  const sdkRuns = separateSdkRuns ? (session.sdkThreads ?? []).flatMap((thread) => thread.runs.map((run) => ({ threadId: thread.id, run }))) : [];
  const sdkThreads = separateSdkRuns ? (session.sdkThreads ?? []).map((thread) => ({ ...thread, runs: [] })) : session.sdkThreads ?? [];
  const domains: DurableSessionPayloads = new Map([
    // updatedAt is intentionally excluded: saveSession refreshes it for every
    // turn, and persisting it here would rewrite the profile on every message.
    ["profile", { model: session.model, totalMessages: session.totalMessages, totalCost: session.totalCost, ...(typeof session.telegramChatId === "number" ? { telegramChatId: session.telegramChatId } : {}), ...(typeof session.voiceReplies === "boolean" ? { voiceReplies: session.voiceReplies } : {}), ...(session.voicePreferences ? { voicePreferences: session.voicePreferences } : {}), createdAt: session.createdAt }],
    ["conversation", { summaries: session.summaries }],
    ["memories", { memories: session.memories }],
    ["assets", { imageAssets: session.imageAssets, sdkFiles: session.sdkFiles ?? [], artifacts: session.artifacts ?? [] }],
    ["sdk", { sdkThreads, sdkIdempotency: session.sdkIdempotency ?? {}, sdkAudit: session.sdkAudit ?? [], sdkWebhooks: session.sdkWebhooks ?? [], sdkProjects: session.sdkProjects ?? [] }],
  ]);
  const core = {
    ...session,
    history: (session.history ?? []).slice(-HOT_CONVERSATION_MESSAGES), summaries: [], memories: [], imageAssets: [], sdkFiles: [], artifacts: [], sdkThreads: [], sdkIdempotency: {}, sdkAudit: [], sdkWebhooks: [], sdkProjects: [],
    durableSessionFormat: DURABLE_SESSION_FORMAT,
  } as SessionWithDurableMarker;
  return { core, domains, sdkRuns };
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Rehydrate a normal UserSession only when all canonical Neon documents exist. */
export function joinSessionDomains(core: UserSession, documents: ReadonlyMap<DurableSessionDomain, unknown>): UserSession {
  if (DURABLE_SESSION_DOMAINS.some((domain) => !documents.has(domain))) throw new Error("Durable session documents are incomplete; refusing to read stale session state.");
  const conversation = object(documents.get("conversation"));
  const profile = object(documents.get("profile"));
  const memories = object(documents.get("memories"));
  const assets = object(documents.get("assets"));
  const sdk = object(documents.get("sdk"));
  const { durableSessionFormat: _marker, ...session } = core as SessionWithDurableMarker;
  return {
    ...session,
    ...(typeof profile.model === "string" ? { model: profile.model } : {}),
    ...(Number.isSafeInteger(profile.totalMessages) && Number(profile.totalMessages) >= 0 ? { totalMessages: Number(profile.totalMessages) } : {}),
    ...(typeof profile.totalCost === "number" && Number.isFinite(profile.totalCost) && profile.totalCost >= 0 ? { totalCost: profile.totalCost } : {}),
    ...(Number.isSafeInteger(profile.telegramChatId) ? { telegramChatId: Number(profile.telegramChatId) } : {}),
    ...(typeof profile.voiceReplies === "boolean" ? { voiceReplies: profile.voiceReplies } : {}),
    ...(profile.voicePreferences && typeof profile.voicePreferences === "object" && !Array.isArray(profile.voicePreferences) ? { voicePreferences: profile.voicePreferences as UserSession["voicePreferences"] } : {}),
    ...(Number.isSafeInteger(profile.createdAt) && Number(profile.createdAt) >= 0 ? { createdAt: Number(profile.createdAt) } : {}),
    ...(Number.isSafeInteger(profile.updatedAt) && Number(profile.updatedAt) >= 0 ? { updatedAt: Number(profile.updatedAt) } : {}),
    history: Array.isArray(conversation.history) ? conversation.history as Message[] : Array.isArray(core.history) ? core.history.slice(-HOT_CONVERSATION_MESSAGES) : [],
    summaries: Array.isArray(conversation.summaries) ? conversation.summaries as string[] : [],
    memories: Array.isArray(memories.memories) ? memories.memories as MemoryFact[] : [],
    imageAssets: Array.isArray(assets.imageAssets) ? assets.imageAssets as ImageAsset[] : [],
    sdkFiles: Array.isArray(assets.sdkFiles) ? assets.sdkFiles as SdkFileRecord[] : [],
    artifacts: Array.isArray(assets.artifacts) ? assets.artifacts as ArtifactRecord[] : [],
    sdkThreads: Array.isArray(sdk.sdkThreads) ? sdk.sdkThreads as SdkThreadRecord[] : [],
    sdkIdempotency: object(sdk.sdkIdempotency) as UserSession["sdkIdempotency"],
    sdkAudit: Array.isArray(sdk.sdkAudit) ? sdk.sdkAudit as UserSession["sdkAudit"] : [],
    sdkWebhooks: Array.isArray(sdk.sdkWebhooks) ? sdk.sdkWebhooks as UserSession["sdkWebhooks"] : [],
    sdkProjects: Array.isArray(sdk.sdkProjects) ? sdk.sdkProjects as UserSession["sdkProjects"] : [],
  };
}
