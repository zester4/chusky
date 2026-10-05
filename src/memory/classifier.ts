import { config } from "../config.js";
import { jevClient, jevEnabled, jevText, withinBudget, type JevChoiceAnswer, type JevClient } from "../decisions/jev.js";
import { recordDecision } from "../decisions/telemetry.js";
import type { MemoryCategory } from "./types.js";

export type MemoryAudience = "owner_only" | "meeting_safe_business" | "sensitive";
export interface MemoryClassification {
  category: MemoryCategory;
  audience: MemoryAudience;
  durable: boolean;
  confidence: number;
  meetingSafe: boolean;
  source: "deterministic" | "jev";
  reason: string;
}

const categories: MemoryCategory[] = ["business", "procedural", "project", "relationship", "preference", "profile", "personal", "episodic", "document", "negative", "fact"];
const categorySet = new Set(categories);
const sensitivePattern = /\b(password|passcode|secret|api[ _-]?key|ssn|social security|health|medical|diagnos|bank|credit card|routing number|salary|income|home address|private address)\b|\b(?:\+?\d[\d ()-]{8,}\d)\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const isSensitive = (value: string) => sensitivePattern.test(value);

function deterministic(input: { key: string; value: string; category?: MemoryCategory; sensitivity?: "normal" | "sensitive" }): MemoryClassification {
  const sensitive = input.sensitivity === "sensitive" || isSensitive(`${input.key} ${input.value}`);
  const category = input.category && categorySet.has(input.category) ? input.category : "fact";
  const meetingSafe = !sensitive && ["business", "procedural", "project"].includes(category) && !/\b(my|i|me|mine|personal|private|home|family|daughter|son|doctor|health|salary|friend)\b/i.test(`${input.key} ${input.value}`);
  return { category, audience: sensitive ? "sensitive" : meetingSafe ? "meeting_safe_business" : "owner_only", durable: Boolean(input.value.trim()), confidence: sensitive ? 1 : 0.5, meetingSafe, source: "deterministic", reason: sensitive ? "Local sensitivity rules require private handling." : "Jev classification was unavailable or disabled; meeting exposure remains closed." };
}

export async function classifyMemory(input: { key: string; value: string; category?: MemoryCategory; sensitivity?: "normal" | "sensitive"; explicit?: boolean; client?: JevClient; sessionId?: string; budgetMs?: number }): Promise<MemoryClassification> {
  const fallback = deterministic(input);
  if (input.sensitivity === "sensitive" || isSensitive(`${input.key} ${input.value}`)) return fallback;
  if (!config.memoryClassificationEnabled || config.jevMode === "off" || !jevEnabled("memory")) return fallback;
  const client = input.client ?? jevClient();
  if (!client.available()) return fallback;
  const questions = {
    category: { type: "choice" as const, instructions: "Classify the durable memory. Choose the narrowest category; do not infer private details.", criteria: Object.fromEntries(categories.map((item) => [item, item])) },
    audience: { type: "choice" as const, instructions: "Choose the least permissive audience. meeting_safe_business requires clearly company-safe information with no personal subject.", criteria: { owner_only: "Only the owner should see this.", meeting_safe_business: "Safe to use in a business meeting.", sensitive: "Sensitive or private; keep out of meetings." } },
    durable: { type: "noul" as const, instructions: "Is this a stable fact, preference, decision, or procedure worth retaining?", criteria: { true: "Useful later.", false: "Transient or speculative." } },
  };
  const result = await withinBudget(client.evaluate({ key: jevText(input.key, 240), value: jevText(input.value, 600), explicit: input.explicit === true }, questions, { sessionId: input.sessionId }), input.budgetMs ?? 400);
  if (!result) return fallback;
  const categoryAnswer = result.answers.category as JevChoiceAnswer;
  const audienceAnswer = result.answers.audience as JevChoiceAnswer;
  const durableAnswer = result.answers.durable;
  const category = categorySet.has(categoryAnswer.choice as MemoryCategory) ? categoryAnswer.choice as MemoryCategory : fallback.category;
  const audience = (["owner_only", "meeting_safe_business", "sensitive"] as string[]).includes(audienceAnswer.choice) ? audienceAnswer.choice as MemoryAudience : "owner_only";
  const confidence = Math.min(categoryAnswer.confidence, audienceAnswer.confidence);
  const meetingSafe = audience === "meeting_safe_business" && confidence >= 0.9 && !isSensitive(`${input.key} ${input.value}`) && ["business", "procedural", "project"].includes(category);
  recordDecision({ surface: "memory", mode: config.jevMode === "enforce" ? "enforce" : "shadow", applied: config.jevMode === "enforce", jev: [{ id: category, p: categoryAnswer.probabilities[category] ?? categoryAnswer.confidence }, { id: audience, p: audienceAnswer.probabilities[audience] ?? audienceAnswer.confidence }], baseline: [fallback.category, fallback.audience], latencyMs: result.latencyMs, costUsd: result.costUsd, model: result.model, routeSource: "jev" });
  if (config.jevMode !== "enforce") return fallback;
  return { category, audience, durable: durableAnswer.type === "noul" ? durableAnswer.noul >= 0.5 : fallback.durable, confidence, meetingSafe, source: "jev", reason: "Jev proposed classification; local sensitivity and meeting-safe constraints remain authoritative." };
}
