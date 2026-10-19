/**
 * Safe, user-facing progress projected from the agent's internal run
 * lifecycle. This module deliberately accepts only content-free activity
 * metadata; provider arguments and results never belong in this contract.
 */

export type SdkRunProgressPhase = "planning" | "researching" | "acting" | "waiting" | "completed" | "failed" | "cancelled";

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

export type SdkProgressActivity = {
  toolSlug: string;
  status: "started" | "completed" | "failed" | "approval_required" | "cancelled";
  message: string;
  actionLabel?: string;
  toolkitSlug?: string;
  toolkitName?: string;
  summary?: string;
  callId?: string;
  durationMs?: number;
};

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
  const phase = raw.phase === "planning" || raw.phase === "researching" || raw.phase === "acting" || raw.phase === "waiting" || raw.phase === "completed" || raw.phase === "failed" || raw.phase === "cancelled"
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

const GENERIC_ACTIVITY_COPY = /^(?:i['’]?m|i am)?\s*(?:taking care of (?:that|it)|working(?: through your request| on it)?|processing (?:your request|that|it)|handling (?:that|it)|running(?: now)?|one moment)[\s.!…]*$/i;
const GENERIC_PROGRESS_COPY = /^(?:preparing your request|researching the request|executing the next action|working(?: now| on it| through your request)?|running(?: now)?|chusky is (?:organizing|keeping the work visible|preparing)(?: the right context)?(?: before it acts)?|i['’]?m\s+(?:understanding(?: your request)?|lining up (?:the )?best way(?: to help)?|taking care of (?:that|it)))[\s.!…]*$/i;

function meaningfulProgressText(value: string | undefined): string | undefined {
  const text = value?.trim();
  const comparable = text?.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return text && comparable && !GENERIC_ACTIVITY_COPY.test(comparable) && !GENERIC_PROGRESS_COPY.test(comparable) ? text : undefined;
}

function titleCaseToken(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function activityProviderName(activity: { toolkitSlug?: unknown; toolkitName?: unknown; toolSlug?: unknown }): string | undefined {
  const supplied = cleanText(activity.toolkitName ?? activity.toolkitSlug, MAX_PROVIDER_CHARS);
  if (supplied) return titleCaseToken(supplied);
  const slug = cleanText(activity.toolSlug, MAX_PROVIDER_CHARS)?.replace(/^(?:CHUCK|COMPOSIO|MCP)_/i, "");
  const provider = slug?.split("_", 1)[0];
  return provider ? titleCaseToken(provider) : undefined;
}

function activityActionToken(activity: { toolkitSlug?: unknown; toolkitName?: unknown; toolSlug?: unknown }): string | undefined {
  let token = cleanText(activity.toolSlug, MAX_TITLE_CHARS)?.replace(/^(?:CHUCK|COMPOSIO|MCP)_/i, "");
  if (!token) return undefined;
  const provider = activityProviderName(activity)?.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (provider && token.toUpperCase().startsWith(`${provider}_`)) token = token.slice(provider.length + 1);
  return titleCaseToken(token);
}

function meaningfulActivityText(...values: unknown[]): string | undefined {
  return values
    .map((value) => cleanText(value, MAX_TITLE_CHARS))
    .find((value) => value && !GENERIC_ACTIVITY_COPY.test(value));
}

function activityTitle(activity: { actionLabel?: unknown; message?: unknown; toolSlug?: unknown; toolkitSlug?: unknown; toolkitName?: unknown }, fallback: string): string {
  const provider = activityProviderName(activity);
  const action = meaningfulActivityText(activity.actionLabel, activity.message) ?? activityActionToken(activity) ?? fallback;
  if (!provider || action.toLowerCase().startsWith(`${provider.toLowerCase()} ·`)) return action;
  return `${provider} · ${action}`.slice(0, MAX_TITLE_CHARS);
}

function activityEvidence(activity: { callId?: unknown; activityId?: unknown; actionLabel?: unknown; message?: unknown; summary?: unknown; status?: unknown; toolSlug?: unknown; toolkitSlug?: unknown; toolkitName?: unknown }): SdkRunEvidence[] | undefined {
  if (activity.status !== "completed") return undefined;
  const detail = cleanText(activity.summary, MAX_EVIDENCE_DETAIL_CHARS);
  if (!detail) return undefined;
  const label = cleanText(activityTitle(activity, "Completed step"), MAX_EVIDENCE_LABEL_CHARS);
  if (!label) return undefined;
  const id = cleanText(activity.callId ?? activity.activityId, MAX_EVIDENCE_ID_CHARS);
  return [{ ...(id ? { id } : {}), label, detail, kind: "step" }];
}

export function progressFromSdkStatus(text: string, previous?: SdkRunProgress): SdkRunProgress {
  const rawStatus = cleanText(text, MAX_DETAIL_CHARS) ?? "";
  const status = meaningfulProgressText(rawStatus);
  const lower = rawStatus.toLowerCase();
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
    title: phase === "waiting" ? "Waiting for your approval" : "Working…",
    ...(status ? { detail: status } : {}),
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
  const message = meaningfulActivityText(activity.message);
  const detail = activity.status === "approval_required"
    ? "Waiting for your approval before this action can continue."
    : activity.status === "completed"
      ? cleanText(activity.summary, MAX_DETAIL_CHARS) ?? "Step completed."
      : activity.status === "failed"
        ? "This step needs attention; the run will report what was confirmed."
        : activity.status === "cancelled"
          ? "This step was cancelled; completed work remains available."
          : message && message.toLowerCase() !== title.toLowerCase() && !GENERIC_ACTIVITY_COPY.test(message) && !GENERIC_PROGRESS_COPY.test(message) ? message : undefined;
  return normalizeSdkRunProgress({
    phase,
    title,
    detail,
    ...(provider ? { provider } : previous?.provider ? { provider: previous.provider } : {}),
    ...(activity.status === "approval_required" ? { requiresApproval: true } : {}),
    ...(activityEvidence(activity) ? { evidence: [...(previous?.evidence ?? []).slice(-7), ...activityEvidence(activity)!] } : previous?.evidence ? { evidence: previous.evidence } : {}),
  })!;
}

/**
 * Publish a bounded, truthful checkpoint after a small group of tool calls.
 * This is deterministic: it describes lifecycle facts and the active action,
 * without asking the model to narrate its own internals.
 */
export function progressFromSdkToolCheckpoint(
  completed: SdkProgressActivity[],
  active?: SdkProgressActivity,
  previous?: SdkRunProgress,
): SdkRunProgress {
  const recent = completed.slice(-4);
  const done = recent.map((item) => activityTitle(item, "Completed step")).filter(Boolean);
  const next = active ? activityTitle(active, "the next verified action") : undefined;
  const provider = active ? providerFor(active) : providerFor(recent.at(-1) ?? {});
  const title = provider ? `${provider} · Progress update` : "Progress update";
  const detail = done.length
    ? `Done: ${done.join("; ")}.${next ? ` Next: ${next}.` : ""}`
    : next
      ? `Next: ${next}.`
      : undefined;
  const phase: SdkRunProgressPhase = active
    ? isResearchActivity(active.toolSlug) ? "researching" : "acting"
    : previous?.phase === "researching" ? "researching" : "acting";
  return normalizeSdkRunProgress({
    phase,
    title,
    ...(detail ? { detail } : {}),
    ...(provider ? { provider } : previous?.provider ? { provider: previous.provider } : {}),
    ...(previous?.evidence ? { evidence: previous.evidence } : {}),
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
  const message = meaningfulActivityText(activity.message);
  const detail = activity.status === "waiting" || activity.status === "approval_required"
    ? "A specialist is waiting before it can continue."
    : message ?? cleanText(activity.objective, MAX_DETAIL_CHARS) ?? "A specialist is working on this step.";
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
  return { phase: "planning", title: "Working…" };
}

export function terminalSdkRunProgress(status: "completed" | "failed" | "cancelled", options: { artifacts?: Array<{ id: string; name: string }>; error?: string; previous?: SdkRunProgress } = {}): SdkRunProgress {
  if (status === "completed") {
    const evidence = options.artifacts?.slice(0, MAX_EVIDENCE_ITEMS).map((artifact) => ({ id: artifact.id, label: cleanText(artifact.name, MAX_EVIDENCE_LABEL_CHARS) ?? "Generated artifact", kind: "artifact" as const, href: `artifact:${artifact.id}` }));
    return normalizeSdkRunProgress({ phase: "completed", title: "Work completed", detail: "Chusky finished the request.", progress: 1, ...(evidence?.length ? { evidence } : options.previous?.evidence ? { evidence: options.previous.evidence } : {}) })!;
  }
  return normalizeSdkRunProgress({
    phase: status,
    title: status === "cancelled" ? "Run cancelled" : "Run needs attention",
    detail: status === "cancelled" ? "Completed steps remain available above." : cleanText(options.error, MAX_DETAIL_CHARS) ?? "The run stopped before completion. Review the details and try again.",
    ...(options.previous?.provider ? { provider: options.previous.provider } : {}),
    ...(options.previous?.evidence ? { evidence: options.previous.evidence } : {}),
  })!;
}
