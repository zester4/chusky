import { readScratchpad } from "../store.js";

/** Reserved owner-private scratchpad entry used as Elena's evolving working plan. */
export const ATTENTION_CHECKLIST_KEY = "attention-pulse/checklist";

export async function readAttentionChecklist(userId: number): Promise<{ content: string; updatedAt: number } | undefined> {
  const entry = (await readScratchpad(userId, ATTENTION_CHECKLIST_KEY))[ATTENTION_CHECKLIST_KEY];
  if (!entry || typeof entry.content !== "string" || !entry.content.trim()) return undefined;
  return { content: entry.content.slice(0, 1000), updatedAt: entry.updatedAt };
}

export function attentionChecklistPrompt(entry: { content: string; updatedAt: number } | undefined): string {
  if (!entry) return "- no Elena checklist exists yet; create a concise initial working checklist with the user's current horizon, known gaps, and the next few useful checks.";
  return `- last updated ${new Date(entry.updatedAt).toISOString()}\n${entry.content}`;
}
