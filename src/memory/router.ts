import { randomUUID } from "node:crypto";
import { getSession, saveSession } from "../store.js";
import { UpstashKnowledgeStore } from "../lib/knowledge/vector.js";
import {
  type MemoryCategory,
  type MemoryRecord,
  type MemoryQueryOptions,
  type CapabilityWorkerName,
  CAPABILITY_MEMORY_ACCESS_MATRIX,
} from "./types.js";

function getVectorStore(): UpstashKnowledgeStore | null {
  try {
    return new UpstashKnowledgeStore();
  } catch {
    return null;
  }
}

export class MemoryRouter {
  /**
   * Save an explicit or clearly durable memory fact into the shared memory service.
   * Performs pre-save category classification and supersession tracking for existing facts.
   */
  async classifyAndSaveMemory(
    userId: number,
    input: {
      category: MemoryCategory;
      key: string;
      value: string;
      source?: string;
      confidence?: number;
      projectId?: string;
      personKey?: string;
      expiresAt?: number;
      reviewAt?: number;
    }
  ): Promise<MemoryRecord> {
    const session = await getSession(userId);
    const memories: MemoryRecord[] = (session.memories as unknown as MemoryRecord[]) ?? [];
    const now = Date.now();
    const cleanKey = input.key.trim().toLowerCase();

    // Check for existing active memory with the same key and category
    const existing = memories.find(
      (m) => m.status === "active" && m.category === input.category && m.key.trim().toLowerCase() === cleanKey
    );

    let supersedesId: string | undefined;
    if (existing) {
      existing.status = "superseded";
      existing.updatedAt = now;
      supersedesId = existing.id;
    }

    const newRecord: MemoryRecord = {
      id: randomUUID(),
      ownerId: userId,
      category: input.category,
      key: input.key.trim(),
      value: input.value.trim(),
      source: input.source ?? "user_explicit",
      confidence: Math.max(0, Math.min(1, input.confidence ?? 1.0)),
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      reviewAt: input.reviewAt,
      status: "active",
      supersedesId,
      projectId: input.projectId,
      personKey: input.personKey,
    };

    const updatedMemories = [...memories.filter((m) => m.id !== existing?.id), ...(existing ? [existing] : []), newRecord];
    session.memories = updatedMemories as unknown as typeof session.memories;
    await saveSession(userId, session);

    // Sync active record to vector knowledge store (best-effort)
    try {
      await getVectorStore()?.upsertMemory({
        userId: String(userId),
        id: newRecord.id,
        category: newRecord.category,
        key: newRecord.key,
        value: newRecord.value,
        projectId: newRecord.projectId,
        personKey: newRecord.personKey,
      });
    } catch {
      /* Vector store sync failure does not break primary store */
    }

    return newRecord;
  }

  /**
   * Scoped query retrieval enforcing category access matrix per domain worker capability.
   */
  async queryScopedMemories(
    userId: number,
    workerName: CapabilityWorkerName,
    options?: MemoryQueryOptions
  ): Promise<MemoryRecord[]> {
    const session = await getSession(userId);
    const memories: MemoryRecord[] = (session.memories as unknown as MemoryRecord[]) ?? [];
    const allowedCategories = CAPABILITY_MEMORY_ACCESS_MATRIX[workerName] ?? [];
    const now = Date.now();

    // Filter active, non-expired memories within worker's allowed category scope
    let candidates = memories.filter((m) => {
      const isStatusValid = options?.includeSuperseded ? m.status !== "deleted" : m.status === "active";
      const isCategoryAllowed = allowedCategories.includes(m.category);
      const isNotExpired = !m.expiresAt || m.expiresAt > now;

      if (!isStatusValid || !isCategoryAllowed || !isNotExpired) return false;

      if (options?.category) {
        const filterCategories = Array.isArray(options.category) ? options.category : [options.category];
        if (!filterCategories.includes(m.category)) return false;
      }

      if (options?.projectId && m.projectId && m.projectId !== options.projectId) return false;
      if (options?.personKey && m.personKey && m.personKey !== options.personKey) return false;

      return true;
    });

    const searchQuery = options?.query?.trim().toLowerCase();
    if (searchQuery) {
      candidates = candidates.filter(
        (m) =>
          m.key.toLowerCase().includes(searchQuery) ||
          m.value.toLowerCase().includes(searchQuery) ||
          m.category.toLowerCase().includes(searchQuery)
      );
    }

    // Sort by confidence & recency, return top bounded limit (default 5)
    candidates.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
    const limit = Math.max(1, Math.min(20, options?.limit ?? 5));
    return candidates.slice(0, limit);
  }

  /**
   * Explicitly update an existing memory fact, creating a supersession trail.
   */
  async updateMemory(
    userId: number,
    keyOrId: string,
    newValue: string,
    updates?: Partial<Omit<MemoryRecord, "id" | "ownerId" | "createdAt" | "status">>
  ): Promise<MemoryRecord | null> {
    const session = await getSession(userId);
    const memories: MemoryRecord[] = (session.memories as unknown as MemoryRecord[]) ?? [];
    const now = Date.now();

    const target = memories.find(
      (m) => m.status === "active" && (m.id === keyOrId || m.key.toLowerCase() === keyOrId.toLowerCase())
    );

    if (!target) return null;

    target.status = "superseded";
    target.updatedAt = now;

    const newRecord: MemoryRecord = {
      id: randomUUID(),
      ownerId: userId,
      category: updates?.category ?? target.category,
      key: updates?.key ?? target.key,
      value: newValue.trim(),
      source: updates?.source ?? target.source ?? "user_update",
      confidence: Math.max(0, Math.min(1, updates?.confidence ?? target.confidence ?? 1.0)),
      createdAt: now,
      updatedAt: now,
      expiresAt: updates?.expiresAt ?? target.expiresAt,
      reviewAt: updates?.reviewAt ?? target.reviewAt,
      status: "active",
      supersedesId: target.id,
      projectId: updates?.projectId ?? target.projectId,
      personKey: updates?.personKey ?? target.personKey,
    };

    session.memories = [...memories.filter((m) => m.id !== target.id), target, newRecord] as unknown as typeof session.memories;
    await saveSession(userId, session);
    return newRecord;
  }

  /**
   * Explicitly remove a memory record by marking its status as deleted.
   */
  async forgetMemory(userId: number, keyOrId: string): Promise<boolean> {
    const session = await getSession(userId);
    const memories: MemoryRecord[] = (session.memories as unknown as MemoryRecord[]) ?? [];

    const target = memories.find(
      (m) => m.status === "active" && (m.id === keyOrId || m.key.toLowerCase() === keyOrId.toLowerCase())
    );

    if (!target) return false;

    target.status = "deleted";
    target.updatedAt = Date.now();

    session.memories = memories as unknown as typeof session.memories;
    await saveSession(userId, session);
    return true;
  }
}

export const memoryRouter = new MemoryRouter();
