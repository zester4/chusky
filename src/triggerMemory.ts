import { createHash } from "node:crypto";
import { upsertMemoryAndContext } from "./store.js";

const TRIGGER_OUTCOME_MEMORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Save a short, owner-private and replay-safe summary of a settled trigger. */
export async function saveTriggerOutcomeMemory(input: { userId: number; eventId: string; triggerSlug: string; result: string }): Promise<void> {
  const eventKey = createHash("sha256").update(input.eventId).digest("hex").slice(0, 32);
  const key = `trigger_outcome_${eventKey}`;
  const conciseResult = input.result
    .replace(/<chusky_actions>[\s\S]*?<\/chusky_actions>/gi, "")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 600);
  if (!conciseResult) return;
  const value = `${input.triggerSlug}: ${conciseResult}`.slice(0, 700);
  const expiresAt = Date.now() + TRIGGER_OUTCOME_MEMORY_TTL_MS;

  await upsertMemoryAndContext(input.userId, {
    category: "episodic",
    key,
    value,
    source: "verified_trigger_outcome",
    confidence: 1,
    sensitivity: "normal",
    expiresAt,
  }, {
    scope: "user",
    kind: "tool_receipt",
    key,
    value,
    source: "verified_trigger_outcome",
    sourceRef: `trigger-event:${eventKey}`,
    confidence: 1,
    sensitivity: "normal",
    tags: ["trigger", "outcome"],
    expiresAt,
  });
}
