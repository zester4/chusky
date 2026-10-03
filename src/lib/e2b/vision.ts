import type { E2BBrowserNode } from "./types.js";

export type VisualTarget = { node: E2BBrowserNode; score: number; reasons: string[] };

function tokens(value: string): string[] { return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

/** Deterministic grounding before any coordinate fallback. This keeps visual targeting explainable. */
export function rankBrowserTargets(nodes: E2BBrowserNode[], requestedName: string, requestedRole?: string): VisualTarget[] {
  const wanted = new Set(tokens(requestedName));
  return nodes.map((node) => {
    const name = new Set(tokens(node.name));
    const overlap = [...wanted].filter((token) => name.has(token)).length;
    const roleScore = requestedRole && node.role === requestedRole ? 4 : requestedRole ? 0 : 1;
    const exact = node.name.trim().toLowerCase() === requestedName.trim().toLowerCase() ? 8 : 0;
    const score = exact + overlap * 2 + roleScore;
    const reasons = [exact ? "exact accessible name" : overlap ? "name token overlap" : "weak name match", roleScore > 1 ? "role match" : "role not constrained"];
    return { node, score, reasons };
  }).filter((item) => item.score > 1).sort((a, b) => b.score - a.score).slice(0, 10);
}
