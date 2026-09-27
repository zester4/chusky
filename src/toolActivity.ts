/** Provider metadata safe for the durable, user-facing run timeline. */
export interface ComposioToolPresentation {
  toolSlug: string;
  actionLabel?: string;
  toolkitSlug?: string;
  toolkitName?: string;
  toolkitLogo?: string;
}

export interface ComposioBatchAction extends ComposioToolPresentation {
  id: string;
  status: "started" | "completed" | "failed" | "unknown" | "approval_required" | "cancelled";
  summary?: string;
}

const safeText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
};

const safeLogo = (value: unknown): string | undefined => {
  const text = safeText(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const normalizeToolSlug = (value: unknown): string | undefined => {
  const slug = safeText(value, 200);
  return slug && /^[A-Z][A-Z0-9_]{1,199}$/.test(slug) && !slug.startsWith("CHUCK_") && !slug.startsWith("COMPOSIO_") && !slug.startsWith("MCP_")
    ? slug
    : undefined;
};

export function fallbackComposioActionLabel(toolSlug: string): string {
  const parts = toolSlug.split("_");
  return parts.length > 1
    ? parts.slice(1).map((part) => part.toLowerCase()).join(" ").replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 120)
    : "Connected app action";
}

/** Harvest only explicit Composio metadata; never infer app identity from a slug. */
export function collectComposioToolPresentations(input: unknown): Map<string, ComposioToolPresentation> {
  let root = input;
  if (typeof root === "string") {
    try { root = JSON.parse(root) as unknown; } catch { return new Map(); }
  }

  const result = new Map<string, ComposioToolPresentation>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length && visited < 500) {
    const current = pending.pop()!;
    visited++;
    if (!current.value || typeof current.value !== "object" || current.depth > 6 || seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value.slice(0, 100)) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    const slug = normalizeToolSlug(record.toolSlug ?? record.tool_slug ?? record.slug);
    const toolkitValue = record.toolkit;
    const toolkit = toolkitValue && typeof toolkitValue === "object" && !Array.isArray(toolkitValue)
      ? toolkitValue as Record<string, unknown>
      : {};
    const toolkitSlug = safeText(typeof toolkitValue === "string" ? toolkitValue : toolkit.slug ?? record.toolkitSlug ?? record.toolkit_slug, 120);
    const toolkitName = safeText(toolkit.name ?? record.toolkitName ?? record.toolkit_name, 120);
    const toolkitLogo = safeLogo(toolkit.logo ?? record.toolkitLogo ?? record.toolkit_logo ?? (record.deprecated && typeof record.deprecated === "object" ? (record.deprecated as Record<string, unknown>).toolkit && typeof (record.deprecated as Record<string, unknown>).toolkit === "object" ? ((record.deprecated as Record<string, unknown>).toolkit as Record<string, unknown>).logo : undefined : undefined));
    const actionLabel = safeText(record.human_description ?? record.humanDescription ?? record.display_name ?? record.displayName ?? record.name ?? record.description, 180);
    if (slug && (toolkitSlug || toolkitName || toolkitLogo || actionLabel)) {
      const previous = result.get(slug);
      result.set(slug, {
        toolSlug: slug,
        ...(actionLabel ? { actionLabel } : previous?.actionLabel ? { actionLabel: previous.actionLabel } : {}),
        ...(toolkitSlug ? { toolkitSlug } : previous?.toolkitSlug ? { toolkitSlug: previous.toolkitSlug } : {}),
        ...(toolkitName ? { toolkitName } : previous?.toolkitName ? { toolkitName: previous.toolkitName } : {}),
        ...(toolkitLogo ? { toolkitLogo } : previous?.toolkitLogo ? { toolkitLogo: previous.toolkitLogo } : {}),
      });
    }
    for (const [key, child] of Object.entries(record)) {
      if (["arguments", "input", "result", "response"].includes(key)) continue;
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return result;
}

/** Attach official Composio toolkit branding to discovered action metadata. */
export function enrichComposioToolPresentationsFromToolkits(
  presentations: Map<string, ComposioToolPresentation>,
  input: unknown,
): void {
  if (!Array.isArray(input)) return;
  const toolkits = new Map<string, { name?: string; logo?: string }>();
  for (const value of input.slice(0, 100)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const slug = safeText(record.slug ?? record.toolkitSlug ?? record.toolkit_slug, 120);
    if (!slug || !/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(slug)) continue;
    const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? record.meta as Record<string, unknown>
      : {};
    const name = safeText(record.name ?? record.displayName ?? record.display_name, 120);
    const logo = safeLogo(meta.logo ?? record.logo);
    if (name || logo) toolkits.set(slug.toLowerCase(), { ...(name ? { name } : {}), ...(logo ? { logo } : {}) });
  }

  for (const [toolSlug, presentation] of presentations) {
    if (!presentation.toolkitSlug) continue;
    const toolkit = toolkits.get(presentation.toolkitSlug.toLowerCase());
    if (!toolkit) continue;
    presentations.set(toolSlug, {
      ...presentation,
      ...(toolkit.name ? { toolkitName: toolkit.name } : {}),
      ...(toolkit.logo ? { toolkitLogo: toolkit.logo } : {}),
    });
  }
}

/** Limit each run to one bounded bulk lookup of official toolkit metadata. */
export function composioToolkitSlugsNeedingMetadata(
  presentations: ReadonlyMap<string, ComposioToolPresentation>,
): string[] {
  return [...new Set([...presentations.values()]
    .filter((presentation) => presentation.toolkitSlug && (!presentation.toolkitName || !presentation.toolkitLogo))
    .map((presentation) => presentation.toolkitSlug!)
    .filter((slug) => /^[a-z0-9][a-z0-9_-]{0,119}$/i.test(slug)))].slice(0, 50);
}

export function buildComposioBatchActions(
  args: Record<string, unknown>,
  callId: string,
  metadata: ReadonlyMap<string, ComposioToolPresentation>,
): ComposioBatchAction[] {
  const inputs = Array.isArray(args.tools) ? args.tools : Array.isArray(args.items) ? args.items : [];
  return inputs.slice(0, 50).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>;
    const toolSlug = normalizeToolSlug(input.tool_slug ?? input.toolSlug ?? input.slug);
    if (!toolSlug) return [];
    const presentation = metadata.get(toolSlug);
    return [{
      id: `${callId}:${index}`,
      toolSlug,
      status: "started" as const,
      actionLabel: presentation?.actionLabel ?? fallbackComposioActionLabel(toolSlug),
      ...(presentation?.toolkitSlug ? { toolkitSlug: presentation.toolkitSlug } : {}),
      ...(presentation?.toolkitName ? { toolkitName: presentation.toolkitName } : {}),
      ...(presentation?.toolkitLogo ? { toolkitLogo: presentation.toolkitLogo } : {}),
    }];
  });
}

type BatchOutcome = { toolSlug: string; status: "completed" | "failed"; summary: string };

/** Only correlate per-action outcomes when the provider explicitly returns the same tool slug. */
export function correlateComposioBatchOutcomes(input: unknown): Map<string, BatchOutcome> {
  let root = input;
  if (typeof root === "string") {
    try { root = JSON.parse(root) as unknown; } catch { return new Map(); }
  }
  const records: Array<Record<string, unknown>> = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length && visited < 500) {
    const current = pending.pop()!;
    visited++;
    if (!current.value || typeof current.value !== "object" || current.depth > 6 || seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value.slice(0, 100)) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    if (normalizeToolSlug(record.tool_slug ?? record.toolSlug)) records.push(record);
    for (const [key, child] of Object.entries(record)) {
      if (["arguments", "input", "result", "response"].includes(key)) continue;
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  const counts = new Map<string, number>();
  for (const record of records) {
    const slug = normalizeToolSlug(record.tool_slug ?? record.toolSlug)!;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const outcomes = new Map<string, BatchOutcome>();
  for (const record of records) {
    const toolSlug = normalizeToolSlug(record.tool_slug ?? record.toolSlug)!;
    if (counts.get(toolSlug) !== 1) continue;
    const explicitSuccess = typeof record.successful === "boolean" ? record.successful
      : typeof record.success === "boolean" ? record.success
        : typeof record.error === "string" ? false : undefined;
    if (explicitSuccess === undefined) continue;
    outcomes.set(toolSlug, { toolSlug, status: explicitSuccess ? "completed" : "failed", summary: explicitSuccess ? "Provider confirmed this action" : "Provider reported this action failed" });
  }
  return outcomes;
}

export function settleComposioBatchActions(actions: ComposioBatchAction[], result: unknown, fallbackSummary?: string): ComposioBatchAction[] {
  const outcomes = correlateComposioBatchOutcomes(result);
  return actions.map((action) => {
    if (action.status !== "started") return action;
    const outcome = outcomes.get(action.toolSlug);
    return outcome
      ? { ...action, status: outcome.status, summary: outcome.summary }
      : { ...action, status: "unknown", summary: fallbackSummary ?? "Batch response received; individual outcome was not identified" };
  });
}
