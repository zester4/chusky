import { memoryRouter } from "./router.js";
import type { MemoryCategory, MemoryRecord } from "./types.js";

/** Store a cross-channel observation without crossing the owner's privacy boundary. */
export async function recordOperatingObservation(input: { ownerId: number; channel: string; category: MemoryCategory; key: string; value: string; source?: string; confidence?: number; projectId?: string; personKey?: string; expiresAt?: number; reviewAt?: number }): Promise<MemoryRecord> {
  return memoryRouter.classifyAndSaveMemory(input.ownerId, { category: input.category, key: input.key, value: input.value, source: input.source ?? `channel:${input.channel}`, confidence: input.confidence, sensitivity: "normal", projectId: input.projectId, personKey: input.personKey, expiresAt: input.expiresAt, reviewAt: input.reviewAt });
}
