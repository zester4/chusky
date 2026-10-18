/**
 * Explicit, user-requested execution boundaries.
 *
 * Routing is normally advisory: Jev may propose several capability surfaces
 * and the agent chooses from the resulting catalog. Phrases such as
 * "Treg only" are different. They are an instruction about what may execute,
 * so they must be represented as a runtime fence rather than left in prose.
 */

export type ExclusiveCapabilitySurface = "treg" | "monid" | "composio" | "native";

export type ExclusiveCapabilityScope = {
  surface: ExclusiveCapabilitySurface;
  reason: "explicit_only" | "explicit_exclusion";
};

const SURFACE_ALIASES: Record<ExclusiveCapabilitySurface, string[]> = {
  treg: ["treg"],
  monid: ["monid", "mon id"],
  composio: ["composio", "connected app", "connected apps"],
  native: ["native tools", "native tool", "chusky tools"],
};

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsSurface(text: string, surface: ExclusiveCapabilitySurface): boolean {
  return SURFACE_ALIASES[surface].some((alias) => new RegExp(`\\b${escaped(alias)}\\b`, "i").test(text));
}

/** Detect only explicit boundaries; ordinary mentions of Treg/Monid do not fence a turn. */
export function resolveExplicitCapabilityScope(text: string): ExclusiveCapabilityScope | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  for (const surface of Object.keys(SURFACE_ALIASES) as ExclusiveCapabilitySurface[]) {
    if (!mentionsSurface(normalized, surface)) continue;
    const surfacePattern = SURFACE_ALIASES[surface].map(escaped).join("|");
    const onlyNearSurface = new RegExp(`(?:\\b(?:use|via|through|with|run|call|search)\\b[^.!?\\n]{0,80}\\b(?:${surfacePattern})\\b[^.!?\\n]{0,24}\\bonly\\b|\\bonly\\b[^.!?\\n]{0,24}\\b(?:${surfacePattern})\\b)`, "i");
    const excludedOtherSurface = /\b(?:not|never|without|no)\b[^.!?\n]{0,80}\b(?:composio|browser|web search|web-search|native tools?|treg|monid)\b/i.test(normalized);
    if (onlyNearSurface.test(normalized)) return { surface, reason: "explicit_only" };
    if (excludedOtherSurface && new RegExp(`\\b(?:not|never|without|no)\\b[^.!?\\n]{0,80}\\b(?:${surfacePattern})\\b`, "i").test(normalized)) {
      return { surface, reason: "explicit_exclusion" };
    }
  }
  return undefined;
}

/** Whether a top-level or nested action belongs to the explicit surface. */
export function toolBelongsToCapabilityScope(toolSlug: string, scope: ExclusiveCapabilityScope): boolean {
  const slug = toolSlug.trim().toUpperCase();
  switch (scope.surface) {
    case "treg": return /^CHUCK_TREG_[A-Z0-9_]+$/.test(slug);
    case "monid": return /^CHUCK_MONID_[A-Z0-9_]+$/.test(slug);
    case "composio": return !slug.startsWith("CHUCK_") && !slug.startsWith("MCP_");
    case "native": return slug.startsWith("CHUCK_") && !slug.startsWith("CHUCK_TREG_") && !slug.startsWith("CHUCK_MONID_");
  }
}

export function capabilityScopeLabel(scope: ExclusiveCapabilityScope): string {
  return scope.surface === "composio" ? "connected-app actions" : `${scope.surface} tools`;
}
