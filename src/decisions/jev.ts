/**
 * Jev (TypeSafe System One) decision client.
 *
 * Jev evaluates one `state` against typed questions and returns calibrated
 * probabilities instead of free text. Chusky uses it only for routing
 * proposals (which skill, toolkit, action, or Treg endpoint fits). It is never
 * an authorization source: approvals, spend guards, and account scope stay in
 * deterministic code.
 *
 * Contract references:
 *   TypeSafe API   POST https://api.typesafe.ai/v1/systemone
 *   OpenRouter     POST https://openrouter.ai/api/alpha/decisions (model typesafe/jev-1.13)
 * Questions in one request are evaluated in parallel against the same state
 * and cannot see each other's answers. A Choice must pick one of the supplied
 * options, so callers always add an explicit abstain option.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

export type JevState = string | Record<string, unknown> | unknown[];

export type JevChoiceQuestion = { type: "choice"; instructions: string | Record<string, unknown>; criteria: Record<string, string> };
export type JevScoreQuestion = { type: "score"; instructions: string | Record<string, unknown>; criteria: string[] };
export type JevNoulQuestion = { type: "noul"; instructions: string | Record<string, unknown>; criteria?: { true: string; false: string } };
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export type JevChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type JevScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export type JevResult = {
  model: string;
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  inputTokens?: number;
  costUsd?: number;
};

export class JevUnavailableError extends Error {
  constructor(message: string, readonly reason: "disabled" | "circuit_open" | "timeout" | "http" | "invalid_response" | "budget" | "network") {
    super(message);
    this.name = "JevUnavailableError";
  }
}

export interface JevClientOptions {
  provider?: "openrouter" | "typesafe";
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Consecutive failures before the breaker opens. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
}

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_TEXT = 4_000;

/** Remove control characters and bound model-facing text. */
export function jevText(value: unknown, max = 400): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Conservative token estimate (JSON chars / 3.5) used for request packing. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 3.5);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function probability(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

function parseProbabilities(raw: unknown, allowed?: Set<string>): Record<string, number> {
  if (!isObject(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (allowed && !allowed.has(key)) continue;
    const p = probability(value);
    if (p !== undefined) out[key] = p;
  }
  return out;
}

/** Validate one answer against the question that produced it. Throws on drift. */
export function parseJevAnswer(question: JevQuestion, raw: unknown): JevAnswer {
  if (!isObject(raw)) throw new JevUnavailableError("Jev answer is missing", "invalid_response");
  if (question.type === "choice") {
    const allowed = new Set(Object.keys(question.criteria));
    const choice = String(raw.choice ?? "");
    if (!allowed.has(choice)) throw new JevUnavailableError("Jev returned a choice outside the supplied options", "invalid_response");
    const probabilities = parseProbabilities(raw.probabilities, allowed);
    const confidence = probability(raw.confidence) ?? probabilities[choice] ?? 0;
    return { type: "choice", choice, confidence, probabilities: Object.keys(probabilities).length ? probabilities : { [choice]: confidence } };
  }
  if (question.type === "score") {
    const score = Number(raw.score);
    if (!Number.isFinite(score)) throw new JevUnavailableError("Jev returned a non-numeric score", "invalid_response");
    return { type: "score", score: Math.max(0, Math.min(question.criteria.length - 1, score)), confidence: probability(raw.confidence) ?? 0, probabilities: parseProbabilities(raw.probabilities) };
  }
  const noul = probability(raw.noul);
  if (noul === undefined) throw new JevUnavailableError("Jev returned a non-numeric noul", "invalid_response");
  return { type: "noul", noul };
}

type Breaker = { failures: number; openUntil: number };

function modelForProvider(provider: "openrouter" | "typesafe", configured: string): string {
  const value = configured.trim();
  if (provider === "typesafe" && value === "typesafe/jev-1.13") return "jev-1.13.0";
  if (provider === "openrouter" && value === "jev-1.13.0") return "typesafe/jev-1.13";
  return value || (provider === "typesafe" ? "jev-1.13.0" : "typesafe/jev-1.13");
}

export class JevClient {
  private readonly provider: "openrouter" | "typesafe";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly breaker: Breaker = { failures: 0, openUntil: 0 };

  constructor(options: JevClientOptions = {}) {
    this.provider = options.provider ?? config.jevProvider;
    this.apiKey = options.apiKey ?? (this.provider === "typesafe" ? config.jevApiKey : config.openRouterApiKey);
    this.model = options.model || modelForProvider(this.provider, config.jevModel);
    this.timeoutMs = options.timeoutMs ?? config.jevTimeoutMs;
    this.fetcher = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.breakerThreshold = options.breakerThreshold ?? 5;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 30_000;
  }

  get modelId(): string { return this.model; }

  available(): boolean {
    return Boolean(this.apiKey) && this.now() >= this.breaker.openUntil;
  }

  private fail(): void {
    this.breaker.failures += 1;
    if (this.breaker.failures >= this.breakerThreshold) {
      this.breaker.openUntil = this.now() + this.breakerCooldownMs;
      this.breaker.failures = 0;
    }
  }

  async evaluate(state: JevState, questions: Record<string, JevQuestion>, options: { signal?: AbortSignal; timeoutMs?: number; sessionId?: string } = {}): Promise<JevResult> {
    if (!this.apiKey) throw new JevUnavailableError("Jev API key is not configured", "disabled");
    if (this.now() < this.breaker.openUntil) throw new JevUnavailableError("Jev circuit breaker is open", "circuit_open");
    const keys = Object.keys(questions);
    if (!keys.length) return { model: this.model, answers: {}, latencyMs: 0 };
    const boundedState = typeof state === "string" ? jevText(state, MAX_TEXT) : state;
    const body: Record<string, unknown> = { model: this.model, state: boundedState, questions };
    if (options.sessionId && this.provider === "openrouter") body.session_id = createHash("sha256").update(options.sessionId).digest("hex").slice(0, 64);
    if (estimateTokens(body) > config.jevMaxRequestTokens) throw new JevUnavailableError("Jev request exceeds the configured token budget", "budget");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const started = this.now();
    try {
      const response = await this.fetcher(this.provider === "typesafe" ? TYPESAFE_URL : OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...(this.provider === "openrouter" ? { "X-Title": "Chusky" } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.fail();
        throw new JevUnavailableError(`Jev returned HTTP ${response.status}`, "http");
      }
      const payload = await response.json() as Record<string, unknown>;
      const rawAnswers = isObject(payload.answers) ? payload.answers : undefined;
      if (!rawAnswers) { this.fail(); throw new JevUnavailableError("Jev response has no answers", "invalid_response"); }
      const answers: Record<string, JevAnswer> = {};
      try {
        for (const key of keys) answers[key] = parseJevAnswer(questions[key], rawAnswers[key]);
      } catch (error) { this.fail(); throw error; }
      this.breaker.failures = 0;
      const usage = isObject(payload.usage) ? payload.usage : {};
      const cost = Number(usage.cost);
      const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens);
      return {
        model: String(payload.model ?? this.model).slice(0, 120),
        answers,
        latencyMs: Math.max(0, this.now() - started),
        ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
        ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
      };
    } catch (error) {
      if (error instanceof JevUnavailableError) throw error;
      // A caller cancellation (turn deadline or user abort) is not a Jev
      // service failure and must not open the breaker.
      if (!options.signal?.aborted) this.fail();
      if (controller.signal.aborted) throw new JevUnavailableError("Jev request timed out or was cancelled", "timeout");
      throw new JevUnavailableError(`Jev request failed: ${jevText(error instanceof Error ? error.message : error, 200)}`, "network");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const NONE_OPTION = "__none__";

export type RankOption = { id: string; description: string };
export type RankedOption = { id: string; probability: number };
export type RankResult = {
  ranked: RankedOption[];
  /** Probability mass Jev assigned to the explicit abstain option in the final round. */
  none: number;
  confidence: number;
  calls: number;
  latencyMs: number;
  costUsd: number;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

function choiceQuestion(instructions: string, options: RankOption[], noneDescription: string): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const option of options) criteria[option.id] = jevText(option.description, 360) || option.id;
  criteria[NONE_OPTION] = noneDescription;
  return { type: "choice", instructions, criteria };
}

/**
 * Rank an arbitrarily large option set. Small sets are one Choice. Large sets
 * run a two-round tournament: shards are packed as parallel questions into
 * token-bounded requests, the best candidates from each shard advance, and a
 * final Choice produces comparable probabilities.
 */
export async function rankOptions(client: JevClient, input: {
  state: JevState;
  instructions: string;
  options: RankOption[];
  noneDescription: string;
  signal?: AbortSignal;
  maxPerQuestion?: number;
  advancePerShard?: number;
  concurrency?: number;
  sessionId?: string;
}): Promise<RankResult> {
  const unique = new Map<string, RankOption>();
  for (const option of input.options) if (option.id && option.id !== NONE_OPTION && !unique.has(option.id)) unique.set(option.id, option);
  const options = [...unique.values()];
  let calls = 0; let latencyMs = 0; let costUsd = 0;
  const record = (result: JevResult) => { calls += 1; latencyMs = Math.max(latencyMs, result.latencyMs); costUsd += result.costUsd ?? 0; };
  if (!options.length) return { ranked: [], none: 1, confidence: 1, calls, latencyMs, costUsd };

  const maxPerQuestion = Math.max(4, Math.min(input.maxPerQuestion ?? config.jevMaxOptionsPerQuestion, 254));
  let finalists = options;
  if (options.length > maxPerQuestion) {
    const shards: RankOption[][] = [];
    for (let index = 0; index < options.length; index += maxPerQuestion) shards.push(options.slice(index, index + maxPerQuestion));
    // Pack shard questions into requests within the token budget. The state is
    // sent once per request; each shard is an independent parallel question.
    const stateTokens = estimateTokens(input.state);
    const budget = config.jevMaxRequestTokens - stateTokens - 200;
    const requests: Array<Record<string, JevQuestion>> = [];
    let current: Record<string, JevQuestion> = {}; let currentTokens = 0;
    shards.forEach((shard, index) => {
      const question = choiceQuestion(input.instructions, shard, input.noneDescription);
      const tokens = estimateTokens(question);
      if (tokens > budget) throw new JevUnavailableError("A single option shard exceeds the Jev token budget", "budget");
      if (currentTokens + tokens > budget && Object.keys(current).length) { requests.push(current); current = {}; currentTokens = 0; }
      current[`shard_${index}`] = question; currentTokens += tokens;
    });
    if (Object.keys(current).length) requests.push(current);
    const results = await mapLimit(requests, input.concurrency ?? 3, (questions) => client.evaluate(input.state, questions, { signal: input.signal, sessionId: input.sessionId }));
    const advance = Math.max(1, input.advancePerShard ?? 3);
    const advanced = new Set<string>();
    for (const result of results) {
      record(result);
      for (const answer of Object.values(result.answers)) {
        if (answer.type !== "choice") continue;
        Object.entries(answer.probabilities)
          .filter(([id, p]) => id !== NONE_OPTION && p >= 0.03)
          .sort((a, b) => b[1] - a[1])
          .slice(0, advance)
          .forEach(([id]) => advanced.add(id));
        if (answer.choice !== NONE_OPTION) advanced.add(answer.choice);
      }
    }
    finalists = options.filter((option) => advanced.has(option.id)).slice(0, maxPerQuestion);
    if (!finalists.length) return { ranked: [], none: 1, confidence: 1, calls, latencyMs, costUsd };
  }

  const finalRound = await client.evaluate(input.state, { rank: choiceQuestion(input.instructions, finalists, input.noneDescription) }, { signal: input.signal, sessionId: input.sessionId });
  record(finalRound);
  const answer = finalRound.answers.rank as JevChoiceAnswer;
  const ranked = Object.entries(answer.probabilities)
    .filter(([id]) => id !== NONE_OPTION)
    .map(([id, p]) => ({ id, probability: p }))
    .sort((a, b) => b.probability - a.probability);
  return { ranked, none: answer.probabilities[NONE_OPTION] ?? (answer.choice === NONE_OPTION ? answer.confidence : 0), confidence: answer.confidence, calls, latencyMs, costUsd };
}

/**
 * Independent multi-label check: one Noul per candidate, evaluated in parallel
 * in a single request. This is how several skills/actions can be selected for
 * one task even though a Choice has one winner.
 */
export async function verifyCandidates(client: JevClient, input: {
  state: JevState;
  candidates: RankOption[];
  question: (candidate: RankOption) => string;
  criteria?: { true: string; false: string };
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<{ scores: Record<string, number>; latencyMs: number; costUsd: number }> {
  if (!input.candidates.length) return { scores: {}, latencyMs: 0, costUsd: 0 };
  const questions: Record<string, JevQuestion> = {};
  const ids: string[] = [];
  input.candidates.forEach((candidate, index) => {
    const key = `c_${index}`;
    ids.push(candidate.id);
    questions[key] = {
      type: "noul",
      instructions: { candidate: { id: candidate.id, description: jevText(candidate.description, 600) }, question: input.question(candidate) },
      ...(input.criteria ? { criteria: input.criteria } : {}),
    };
  });
  const result = await client.evaluate(input.state, questions, { signal: input.signal, sessionId: input.sessionId });
  const scores: Record<string, number> = {};
  ids.forEach((id, index) => {
    const answer = result.answers[`c_${index}`];
    if (answer?.type === "noul") scores[id] = answer.noul;
  });
  return { scores, latencyMs: result.latencyMs, costUsd: result.costUsd ?? 0 };
}

let sharedClient: JevClient | undefined;

export function jevEnabled(surface?: "skills" | "composio" | "treg" | "autonomy" | "browser" | "native"): boolean {
  if (config.jevMode === "off") return false;
  if (surface && !config.jevSurfaces.has(surface)) return false;
  return Boolean(config.jevProvider === "typesafe" ? config.jevApiKey : config.openRouterApiKey);
}

export function jevClient(): JevClient {
  sharedClient ??= new JevClient();
  return sharedClient;
}

export function setJevClientForTests(client: JevClient | undefined): void {
  sharedClient = client;
}

/** Race a promise against a deadline; resolves undefined on timeout or error. */
export async function withinBudget<T>(promise: Promise<T>, ms: number, onError?: (error: unknown) => void): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } catch (error) {
    onError?.(error);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One shared deadline for every routing surface in a turn. All enforce-mode
 * routes race the same wall-clock instant, and the signal aborts in-flight
 * Jev and catalogue requests when it passes, so routing can never add more
 * than the configured budget to the critical path.
 */
export type RoutingDeadline = {
  at: number;
  signal: AbortSignal;
  remaining(): number;
  dispose(): void;
};

export function createRoutingDeadline(budgetMs = config.jevTurnBudgetMs, parent?: AbortSignal, now: () => number = Date.now): RoutingDeadline {
  const controller = new AbortController();
  const at = now() + Math.max(0, budgetMs);
  const timer = setTimeout(() => controller.abort(), Math.max(0, budgetMs));
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    at,
    signal: controller.signal,
    remaining: () => Math.max(0, at - now()),
    dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", onParentAbort); },
  };
}

/** Wait for a route until the deadline; never rejects. */
export async function awaitRoute<T>(run: Promise<T>, ms: number): Promise<{ value?: T; failure?: string }> {
  if (ms <= 0) { run.catch(() => undefined); return { failure: "timeout" }; }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ failure: "timeout" }), ms);
    run.then((value) => { clearTimeout(timer); resolve({ value }); })
      .catch((error) => { clearTimeout(timer); resolve({ failure: (error as { reason?: string })?.reason ?? (error instanceof Error ? error.name : "error") }); });
  });
}
