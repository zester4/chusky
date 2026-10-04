import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DURABLE_SESSION_DOMAINS, type DurableSessionDomain, type DurableSessionDocument, type DurableConversationMessage, type NeonDurableState } from "./neonDurableState.js";
import { DURABLE_SESSION_FORMAT, HOT_CONVERSATION_MESSAGES, sessionUsesNeonDomains, splitSessionDomains } from "./sessionDomains.js";
import type { UserSession } from "./store.js";

export type DurableSessionBackfillResult = "migrated" | "already_migrated" | "redis_changed" | "neon_conflict";

export interface DurableSessionBackfillDependencies {
  state: Pick<NeonDurableState, "readSessionDomains" | "appendConversationMessages" | "writeSessionDomains">;
  compareAndSetRedisSession(userId: number, expectedRaw: string, replacement: string): Promise<boolean>;
}

function legacyMessages(userId: number, session: UserSession): DurableConversationMessage[] {
  return (Array.isArray(session.history) ? session.history : []).flatMap((message, index) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") return [];
    const id = typeof message.id === "string" && /^[A-Za-z0-9:_-]{1,180}$/.test(message.id)
      ? message.id
      : `legacy_${createHash("sha256").update(`${userId}:${index}:${message.role}:${message.createdAt ?? index}:${message.sourceId ?? ""}:${message.content}`).digest("hex").slice(0, 48)}`;
    const content = message.content.length <= 12_000 ? message.content : `${message.content.slice(0, 8_900)}\n[content truncated for durable storage]\n${message.content.slice(-2_900)}`;
    return [{ id, role: message.role, content, createdAt: typeof message.createdAt === "number" && Number.isFinite(message.createdAt) && message.createdAt >= 0 ? message.createdAt : Date.now() + index, ...(typeof message.sourceId === "string" && message.sourceId.length <= 160 ? { sourceId: message.sourceId } : {}) }];
  });
}

function domainsMatch(documents: Map<DurableSessionDomain, DurableSessionDocument>, domains: Map<DurableSessionDomain, unknown>): boolean {
  return DURABLE_SESSION_DOMAINS.every((domain) => documents.has(domain) && isDeepStrictEqual(documents.get(domain)!.payload, domains.get(domain)));
}

/** Migrate one immutable Redis snapshot; the final marker is installed only by exact-value CAS. */
export async function backfillDurableSessionSnapshot(userId: number, raw: string, dependencies: DurableSessionBackfillDependencies): Promise<DurableSessionBackfillResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("A positive owner ID is required for session backfill.");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Legacy session is not a JSON object.");
  if (sessionUsesNeonDomains(parsed as UserSession)) return "already_migrated";

  const session = parsed as UserSession;
  const withIds = { ...session, history: legacyMessages(userId, session) } as UserSession;
  const { core, domains } = splitSessionDomains(withIds);
  const existing = await dependencies.state.readSessionDomains(userId);
  if (existing.size) {
    if (!domainsMatch(existing, domains)) return "neon_conflict";
  } else {
    await dependencies.state.appendConversationMessages(userId, withIds.history.map(({ id, role, content, createdAt, sourceId }) => ({ id: id!, role, content, createdAt: createdAt ?? Date.now(), ...(sourceId ? { sourceId } : {}) })));
    try {
      await dependencies.state.writeSessionDomains(userId, domains, [], new Map(DURABLE_SESSION_DOMAINS.map((domain) => [domain, undefined])));
    } catch (error) {
      if (!(error instanceof Error) || !/domain version conflict/i.test(error.message)) throw error;
      const raced = await dependencies.state.readSessionDomains(userId);
      if (!domainsMatch(raced, domains)) return "neon_conflict";
    }
  }

  const coreRecord = core as UserSession & Record<string, unknown>;
  coreRecord.history = withIds.history.slice(-HOT_CONVERSATION_MESSAGES);
  coreRecord.durableConversationHeadId = withIds.history.at(-1)?.id;
  coreRecord.durableSessionFormat = DURABLE_SESSION_FORMAT;
  const replacement = JSON.stringify({ ...coreRecord, approvals: [] });
  return await dependencies.compareAndSetRedisSession(userId, raw, replacement) ? "migrated" : "redis_changed";
}
