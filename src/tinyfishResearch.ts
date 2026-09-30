import { createAttentionRecord, getAttentionRecord, updateAttentionRecord, type TinyFishResearchRunRecord } from "./store.js";
import { assertPublicHttpUrl, createTinyFishClient } from "./tinyfish.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeSavedRun(value: Record<string, unknown>, fallback: TinyFishResearchRunRecord) {
  const deep = object(value.deep_result);
  const quick = object(value.quick_result);
  const statusValue = String(value.status ?? fallback.status).toUpperCase();
  const status = (["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(statusValue) ? statusValue : fallback.status) as TinyFishResearchRunRecord["status"];
  const report = typeof deep.result === "string" ? deep.result.slice(0, 40_000) : typeof quick.answer === "string" ? quick.answer.slice(0, 40_000) : fallback.report;
  const progressValue = [value.progress, value.current_step, value.stage, value.message].find((item): item is string => typeof item === "string" && item.trim().length > 0);
  const errorValue = value.failure_reason ?? value.error ?? value.termination_reason;
  const failureReason = typeof errorValue === "string" ? errorValue.slice(0, 1_000) : typeof object(errorValue).message === "string" ? String(object(errorValue).message).slice(0, 1_000) : fallback.failureReason;
  const citationValue = deep.citations ?? quick.citations ?? fallback.citations;
  const citations = Array.isArray(citationValue) ? citationValue.slice(0, 100).flatMap((item) => {
    if (typeof item === "string") { try { return [{ url: assertPublicHttpUrl(item).slice(0, 2_000) }]; } catch { return []; } }
    const citation = object(item);
    if (typeof citation.url !== "string") return [];
    try {
      const url = assertPublicHttpUrl(citation.url).slice(0, 2_000);
      return [{ url, ...(typeof citation.title === "string" ? { title: citation.title.slice(0, 500) } : {}), ...(typeof citation.snippet === "string" ? { snippet: citation.snippet.slice(0, 1_500) } : {}) }];
    } catch { return []; }
  }) : [];
  return { status, report, citations, progress: progressValue?.slice(0, 1_000) ?? fallback.progress, failureReason };
}

export async function reconcileTinyFishResearchRun(userId: number, runRecordId: string, apiKey: string): Promise<TinyFishResearchRunRecord> {
  const record = await getAttentionRecord(userId, "tinyfish_research_run", runRecordId) as TinyFishResearchRunRecord | undefined;
  if (!record) throw new Error("Owner-scoped TinyFish research run was not found.");
  if (record.status !== "RUNNING") return record;
  const providerRun = await createTinyFishClient(apiKey).getResearchRun(record.providerRunId);
  const normalized = normalizeSavedRun(providerRun, record);
  const updated = await updateAttentionRecord(userId, "tinyfish_research_run", record.id, normalized) as TinyFishResearchRunRecord | undefined;
  if (!updated) throw new Error("TinyFish research owner record disappeared during reconciliation.");
  if (updated.status !== "RUNNING") {
    const completed = updated.status === "COMPLETED";
    await createAttentionRecord(userId, "observation", {
      source: "tinyfish_research", eventType: completed ? "research_completed" : "research_failed",
      summary: completed ? `Your TinyFish research report is ready: ${updated.query.slice(0, 250)} (${updated.citations.length} cited sources).` : `TinyFish research ${updated.status.toLowerCase()}: ${updated.query.slice(0, 250)}.`,
      entityId: updated.id, dedupeKey: `tinyfish-research:${updated.id}:${updated.status}`.slice(0, 300), occurredAt: Date.now(),
      importance: completed ? 0.55 : 0.8, novelty: 0.8, confidence: 1, privacyScope: "private", status: "new",
      metadata: { reportId: updated.id, state: updated.status, citations: updated.citations.length },
    });
  }
  return updated;
}
