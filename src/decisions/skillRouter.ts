/**
 * Skill routing: choose the project skill(s) whose guidance should be loaded
 * before the first model call.
 *
 * Stage 1 ranks every installed skill in one Choice (with an explicit
 * "no skill" option). Stage 2 independently verifies the top candidates with
 * parallel Noul questions, so a task can bind several skills (for example a
 * landing page that also needs SEO) instead of one forced winner.
 * Keyword routing remains the fallback and the shadow-mode baseline.
 */
import { config } from "../config.js";
import { listSkillSummaries, routedSkillNames, type SkillBinding } from "../skills/catalog.js";
import { awaitRoute, jevClient, jevEnabled, jevText, rankOptions, verifyCandidates, type JevClient, type RankedOption, type RoutingDeadline } from "./jev.js";
import { recordDecision } from "./telemetry.js";

export type SkillRoute = {
  binding: SkillBinding;
  source: "jev" | "keyword";
  /** Whether keyword/term search fallback should still be appended. */
  allowSearchFallback: boolean;
  ranked?: RankedOption[];
  verified?: Record<string, number>;
  fallbackReason?: string;
  telemetry?: { latencyMs: number; costUsd: number };
};

const MAX_PRIMARY = 2;
const MAX_TOTAL = 4; // Jev-selected skills; keyword routes are added on top.
const VERIFY_CANDIDATES = 6;

function keywordRoute(query: string, reason?: string): SkillRoute {
  return { binding: { primary: routedSkillNames(query), supporting: [] }, source: "keyword", allowSearchFallback: true, ...(reason ? { fallbackReason: reason } : {}) };
}

/**
 * Skill names the user explicitly invoked ("use the seo-audit skill",
 * "/cold-email") are always honoured. Bare common words such as "pdf" or
 * "media" are not treated as explicit invocations.
 */
export function explicitlyNamedSkills(query: string, names: string[]): string[] {
  const text = query.toLowerCase();
  return names.filter((name) => {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = String.raw`(?:^|[^a-z0-9-])`;
    const after = String.raw`(?:$|[^a-z0-9-])`;
    if (new RegExp(String.raw`(?:^|\s)/${escaped}${after}`).test(text)) return true;
    if (new RegExp(String.raw`${before}${escaped}\s+skill\b`).test(text)) return true;
    if (new RegExp(String.raw`\bskill\s+${escaped}${after}`).test(text)) return true;
    return name.includes("-") && new RegExp(`${before}${escaped}${after}`).test(text);
  });
}

export async function computeJevSkillRoute(query: string, options: { client?: JevClient; root?: string; signal?: AbortSignal; recentContext?: string; sessionId?: string } = {}): Promise<SkillRoute> {
  const client = options.client ?? jevClient();
  const skills = await listSkillSummaries(options.root);
  if (!skills.length) return keywordRoute(query, "no_skills_installed");
  const state = {
    request: jevText(query, 3_000),
    ...(options.recentContext ? { recent_conversation: jevText(options.recentContext, 1_200) } : {}),
  };
  const ranking = await rankOptions(client, {
    state,
    instructions: "Which installed skill's operating guidance should Chusky load to complete `request` with the best outcome? Prefer the skill whose description matches the actual deliverable or workflow, not incidental words.",
    options: skills.map((skill) => ({ id: skill.name, description: skill.description })),
    noneDescription: "No skill applies: small talk, a simple factual answer, or a task no listed skill covers.",
    signal: options.signal,
    sessionId: options.sessionId,
  });
  // A Choice concentrates mass on one winner, so a second relevant skill can
  // score low. Verify the top candidates independently instead of cutting at
  // a probability threshold.
  const candidates = ranking.ranked.filter((item) => item.probability >= 0.01).slice(0, VERIFY_CANDIDATES);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const verification = candidates.length
    ? await verifyCandidates(client, {
      state,
      candidates: candidates.map((item) => ({ id: item.id, description: byName.get(item.id)?.description ?? item.id })),
      question: () => "Would loading `candidate` skill guidance materially improve Chusky's result for `request`?",
      criteria: { true: "The skill's workflow, rules, or checklists directly apply to this request.", false: "The skill is unrelated or only superficially related." },
      signal: options.signal,
      sessionId: options.sessionId,
    })
    : { scores: {} as Record<string, number>, latencyMs: 0, costUsd: 0 };

  const explicit = explicitlyNamedSkills(query, skills.map((skill) => skill.name));
  const verified = candidates
    .filter((item) => (verification.scores[item.id] ?? 0) >= config.jevSkillVerifyThreshold)
    .map((item) => ({ ...item, score: item.probability * 0.5 + (verification.scores[item.id] ?? 0) * 0.5 }))
    .sort((a, b) => b.score - a.score);
  const jevPrimary = verified.filter((item, index) => index === 0 || item.probability >= config.jevSkillMinProbability).slice(0, MAX_PRIMARY).map((item) => item.id);
  const primary = [...new Set([...explicit, ...jevPrimary])];
  const jevSupporting = verified.map((item) => item.id).filter((name) => !primary.includes(name));
  // Jev is additive: deterministic keyword routes are never removed by a
  // (possibly confident but wrong) Jev answer, including __none__.
  const keyword = routedSkillNames(query).filter((name) => !primary.includes(name) && !jevSupporting.includes(name));
  const supporting = [...jevSupporting.slice(0, Math.max(0, MAX_TOTAL - primary.length)), ...keyword];
  const route: SkillRoute = {
    binding: { primary, supporting },
    source: "jev",
    // Fuzzy term search stays as a fallback unless the user explicitly
    // selected a skill.
    allowSearchFallback: !explicit.length,
    ranked: ranking.ranked.slice(0, 8),
    verified: verification.scores,
  };
  if (!jevPrimary.length && !explicit.length && ranking.confidence < config.jevMinConfidence) route.fallbackReason = "low_confidence";
  route.telemetry = { latencyMs: ranking.latencyMs + verification.latencyMs, costUsd: ranking.costUsd + verification.costUsd };
  return route;
}

/**
 * Route skills for one supervisor turn according to JEV_MODE.
 *  - off:     keyword routing only.
 *  - shadow:  keyword routing is returned; Jev runs in the background and the
 *             comparison is logged.
 *  - enforce: Jev's verified set is used; any failure, timeout, or low
 *             confidence falls back to keyword routing.
 */
export async function routeSkillsForTurn(query: string, options: { root?: string; signal?: AbortSignal; recentContext?: string; sessionId?: string; client?: JevClient; budgetMs?: number; deadline?: RoutingDeadline } = {}): Promise<SkillRoute> {
  const baseline = keywordRoute(query);
  if (!query.trim() || !jevEnabled("skills")) return baseline;
  const client = options.client ?? jevClient();
  if (!client.available()) return keywordRoute(query, "jev_unavailable");
  // Enforce mode is bound to the shared turn deadline; shadow mode runs in
  // the background under the caller's signal only.
  const enforce = config.jevMode === "enforce";
  const run = computeJevSkillRoute(query, { ...options, client, signal: enforce && options.deadline ? options.deadline.signal : options.signal });
  const log = (route: SkillRoute | undefined, applied: boolean, reason?: string) => {
    const telemetry = route?.telemetry;
    recordDecision({
      surface: "skills",
      mode: config.jevMode === "enforce" ? "enforce" : "shadow",
      applied,
      ...(reason ? { fallbackReason: reason } : {}),
      ...(route?.ranked ? { jev: [...route.binding.primary, ...route.binding.supporting].map((id) => ({ id, p: route.ranked!.find((item) => item.id === id)?.probability ?? 0 })) } : {}),
      baseline: baseline.binding.primary,
      ...(telemetry ? { latencyMs: telemetry.latencyMs, costUsd: telemetry.costUsd } : {}),
      model: client.modelId,
    });
  };

  if (config.jevMode === "shadow") {
    run.then((route) => log(route, false, route.fallbackReason)).catch((error) => log(undefined, false, error instanceof Error ? error.name : "error"));
    return baseline;
  }

  const { value: route, failure } = await awaitRoute(run, options.deadline ? options.deadline.remaining() : options.budgetMs ?? config.jevTurnBudgetMs);
  if (!route || route.fallbackReason) {
    const reason = failure ?? route?.fallbackReason ?? "unavailable";
    log(route, false, reason);
    return keywordRoute(query, reason);
  }
  log(route, true);
  return route;
}
