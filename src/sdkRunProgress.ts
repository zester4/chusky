/**
 * Safe, user-facing progress projected from the agent's internal run
 * lifecycle. This module deliberately accepts only content-free activity
 * metadata; provider arguments and results never belong in this contract.
 */

export type SdkRunProgressPhase = "planning" | "researching" | "acting" | "waiting" | "completed";

export type SdkRunEvidenceKind = "source" | "artifact" | "step" | "note";

export interface SdkRunEvidence {
  id?: string;
  label: string;
  detail?: string;
  kind?: SdkRunEvidenceKind;
  href?: string;
}
export interface SdkRunProgress {
  phase: SdkRunProgressPhase;
  title: string;
  detail?: string;
  provider?: string;
  progress?: number;
  requiresApproval?: boolean;
  evidence?: SdkRunEvidence[];
}

const MAX_TITLE_CHARS = 240;
const MAX_DETAIL_CHARS = 500;
const MAX_PROVIDER_CHARS = 80;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LABEL_CHARS = 160;
const MAX_EVIDENCE_DETAIL_CHARS = 300;
const MAX_EVIDENCE_ID_CHARS = 160;
const SAFE_HREF = /^(?:https?:|artifact:|sandbox:)/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function cleanText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxChars) : undefined;
}

function safeHref(value: unknown): string | undefined {
  const href = cleanText(value, 2_000);
  return href && SAFE_HREF.test(href) ? href : undefined;
}

function progressValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

function evidenceKind(value: unknown): SdkRunEvidenceKind | undefined {
  return value === "source" || value === "artifact" || value === "step" || value === "note" ? value : undefined;
}

/** Normalize both new and legacy records before they cross the API boundary. */
export function normalizeSdkRunProgress(value: unknown): SdkRunProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const phase = raw.phase === "planning" || raw.phase === "researching" || raw.phase === "acting" || raw.phase === "waiting" || raw.phase === "completed"
    ? raw.phase
    : undefined;
  const title = cleanText(raw.title, MAX_TITLE_CHARS);
  if (!phase || !title) return undefined;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.slice(0, MAX_EVIDENCE_ITEMS).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rawEvidence = item as Record<string, unknown>;
      const label = cleanText(rawEvidence.label, MAX_EVIDENCE_LABEL_CHARS);
      if (!label) return [];
      return [{
        ...(cleanText(rawEvidence.id, MAX_EVIDENCE_ID_CHARS) ? { id: cleanText(rawEvidence.id, MAX_EVIDENCE_ID_CHARS) } : {}),
        label,
        ...(cleanText(rawEvidence.detail, MAX_EVIDENCE_DETAIL_CHARS) ? { detail: cleanText(rawEvidence.detail, MAX_EVIDENCE_DETAIL_CHARS) } : {}),
        ...(evidenceKind(rawEvidence.kind) ? { kind: evidenceKind(rawEvidence.kind) } : {}),
        ...(safeHref(rawEvidence.href) ? { href: safeHref(rawEvidence.href) } : {}),
      } satisfies SdkRunEvidence];
    })
    : [];
  return {
    phase,
    title,
    ...(cleanText(raw.detail, MAX_DETAIL_CHARS) ? { detail: cleanText(raw.detail, MAX_DETAIL_CHARS) } : {}),
    ...(cleanText(raw.provider, MAX_PROVIDER_CHARS) ? { provider: cleanText(raw.provider, MAX_PROVIDER_CHARS) } : {}),
    ...(progressValue(raw.progress) !== undefined ? { progress: progressValue(raw.progress) } : {}),
    ...(typeof raw.requiresApproval === "boolean" ? { requiresApproval: raw.requiresApproval } : {}),
    ...(evidence.length ? { evidence } : {}),
  };
}

function providerFor(activity: { toolkitSlug?: unknown; toolkitName?: unknown; toolSlug?: unknown }): string | undefined {
  return cleanText(activity.toolkitSlug ?? activity.toolkitName ?? activity.toolSlug, MAX_PROVIDER_CHARS);
}

function isResearchActivity(toolSlug: string | undefined): boolean {
  return /(?:SEARCH|FETCH|LIST|GET|READ|LOOKUP|FIND|QUERY|BROWSE|CHECK|INSPECT|DESCRIBE|DISCOVER|AVAILABILITY|CALENDAR)/i.test(toolSlug ?? "");
}

function activityTitle(activity: { actionLabel?: unknown; message?: unknown; toolSlug?: unknown }, fallback: string): string {
  return cleanText(activity.actionLabel ?? activity.message, MAX_TITLE_CHARS) ?? fallback;
}

function activityEvidence(activity: { callId?: unknown; activityId?: unknown; actionLabel?: unknown; message?: unknown; summary?: unknown; status?: unknown }): SdkRunEvidence[] | undefined {
  if (activity.status !== "completed") return undefined;
  const detail = cleanText(activity.summary, MAX_EVIDENCE_DETAIL_CHARS);
  if (!detail) return undefined;
  const label = cleanText(activity.actionLabel ?? activity.message, MAX_EVIDENCE_LABEL_CHARS);
  if (!label) return undefined;
  const id = cleanText(activity.callId ?? activity.activityId, MAX_EVIDENCE_ID_CHARS);
  return [{ ...(id ? { id } : {}), label, detail, kind: "step" }];
}

export function progressFromSdkStatus(text: string, previous?: SdkRunProgress): SdkRunProgress {
  const status = cleanText(text, MAX_DETAIL_CHARS) ?? "Chusky is keeping the work visible while it continues.";
  const lower = status.toLowerCase();
  const phase: SdkRunProgressPhase = lower.includes("approval") || lower.includes("review")
    ? "waiting"
    : lower.includes("finaliz") || lower.includes("pulling everything")
      ? "acting"
      : lower.includes("search") || lower.includes("research") || lower.includes("guidance")
        ? "researching"
        : lower.includes("prepar") || lower.includes("understand") || lower.includes("context")
          ? "planning"
          : previous?.phase ?? "planning";
  return normalizeSdkRunProgress({
    phase,
    title: phase === "planning" ? "Preparing your request" : phase === "researching" ? "Researching the request" : phase === "waiting" ? "Waiting for your approval" : "Working on your request",
    detail: status,
    ...(previous?.provider ? { provider: previous.provider } : {}),
    ...(previous?.evidence ? { evidence: previous.evidence } : {}),
  })!;
}
export function progressFromSdkToolActivity(activity: {
  toolSlug: string;
  status: "started" | "completed" | "failed" | "approval_required" | "cancelled";
  message: string;
  actionLabel?: string;
  toolkitSlug?: string;
  toolkitName?: string;
  summary?: string;
  callId?: string;
  durationMs?: number;
}, previous?: SdkRunProgress): SdkRunProgress {
  const phase: SdkRunProgressPhase = activity.status === "approval_required"
    ? "waiting"
    : isResearchActivity(activity.toolSlug)
      ? "researching"
      : "acting";
  const provider = providerFor(activity);
  const fallback = provider ? `Working with ${provider}` : "Working on your request";
  const title = activityTitle(activity, fallback);
  const detail = activity.status === "approval_required"
    ? "Waiting for your approval before this action can continue."
    : activity.status === "completed"
      ? cleanText(activity.summary, MAX_DETAIL_CHARS) ?? "Step completed."
      : activity.status === "failed"
        ? "This step needs attention; the run will report what was confirmed."
        : activity.status === "cancelled"
          ? "This step was cancelled; completed work remains available."
          : cleanText(activity.message, MAX_DETAIL_CHARS) ?? "Chusky is working on this step.";
  return normalizeSdkRunProgress({
    phase,
    title,
    detail,
    ...(provider ? { provider } : previous?.provider ? { provider: previous.provider } : {}),
    ...(activity.status === "approval_required" ? { requiresApproval: true } : {}),
    ...(activityEvidence(activity) ? { evidence: [...(previous?.evidence ?? []).slice(-7), ...activityEvidence(activity)!] } : previous?.evidence ? { evidence: previous.evidence } : {}),
  })!;
}

export function progressFromSdkSubagentActivity(activity: {
  status: "started" | "completed" | "failed" | "approval_required" | "cancelled" | "waiting";
  message: string;
  objective: string;
  worker: string;
  actionLabel?: string;
  toolkitSlug?: string;
  toolkitName?: string;
  summary?: string;
  activityId?: string;
}, previous?: SdkRunProgress): SdkRunProgress {
  const phase: SdkRunProgressPhase = activity.status === "approval_required" || activity.status === "waiting" ? "waiting" : "researching";
  const provider = providerFor(activity);
  const title = activityTitle(activity, `${cleanText(activity.worker, 80) ?? "A specialist"} is working`);
  const detail = activity.status === "waiting" || activity.status === "approval_required"
    ? "A specialist is waiting before it can continue."
    : cleanText(activity.message, MAX_DETAIL_CHARS) ?? cleanText(activity.objective, MAX_DETAIL_CHARS) ?? "A specialist is working on this step.";
  const evidence = activity.status === "completed" && cleanText(activity.summary, MAX_EVIDENCE_DETAIL_CHARS)
    ? [{ id: cleanText(activity.activityId, MAX_EVIDENCE_ID_CHARS), label: title, detail: cleanText(activity.summary, MAX_EVIDENCE_DETAIL_CHARS)!, kind: "step" as const }]
    : undefined;
  return normalizeSdkRunProgress({
    phase,
    title,
    detail,
    ...(provider ? { provider } : previous?.provider ? { provider: previous.provider } : {}),
    ...(activity.status === "approval_required" ? { requiresApproval: true } : {}),
    ...(evidence ? { evidence: [...(previous?.evidence ?? []).slice(-7), ...evidence] } : previous?.evidence ? { evidence: previous.evidence } : {}),
  })!;
}

export function initialSdkRunProgress(): SdkRunProgress {
  return { phase: "planning", title: "Preparing your request", detail: "Chusky is organizing the right context before it acts." };
}

export function terminalSdkRunProgress(status: "completed" | "failed" | "cancelled", options: { artifacts?: Array<{ id: string; name: string }>; error?: string; previous?: SdkRunProgress } = {}): SdkRunProgress {
  if (status === "completed") {
    const evidence = options.artifacts?.slice(0, MAX_EVIDENCE_ITEMS).map((artifact) => ({ id: artifact.id, label: cleanText(artifact.name, MAX_EVIDENCE_LABEL_CHARS) ?? "Generated artifact", kind: "artifact" as const, href: `artifact:${artifact.id}` }));
    return normalizeSdkRunProgress({ phase: "completed", title: "Work completed", detail: "Chusky finished the request.", progress: 1, ...(evidence?.length ? { evidence } : options.previous?.evidence ? { evidence: options.previous.evidence } : {}) })!;
  }
  return normalizeSdkRunProgress({
    phase: "waiting",
    title: status === "cancelled" ? "Run cancelled" : "Run needs attention",
    detail: status === "cancelled" ? "Completed steps remain available above." : cleanText(options.error, MAX_DETAIL_CHARS) ?? "The run stopped before completion. Review the details and try again.",
    ...(options.previous?.provider ? { provider: options.previous.provider } : {}),
    ...(options.previous?.evidence ? { evidence: options.previous.evidence } : {}),
  })!;
}
