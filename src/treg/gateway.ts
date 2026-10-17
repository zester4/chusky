import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { TregCallReceipt, TregCategory, TregCompanyJobResult, TregCompanySearchResult, TregEndpointHit, TregEvidenceBundle, TregEvidenceItem, TregOAuthConnection, TregOwnTool, TregPersonSearchResult, TregPlatformOption } from "./types.js";
import type { TregSpendGuard } from "./spend.js";
import type { TregEndpointJudge } from "../decisions/tregRouter.js";
import { buildTregAdminRequest, sanitizeTregAdminResult } from "./management.js";

export interface TregGatewayDeps {
  spend: TregSpendGuard;
  recordReceipt: (receipt: TregCallReceipt) => Promise<void>;
  recordMissionEvidence?: (input: { userId: number; missionId: string; receipt: TregCallReceipt; resultHash: string }) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional semantic fit judge (Jev). It only reorders candidates; account,
   * BYOK, spend, and budget filters are applied by the gateway regardless.
   */
  judge?: TregEndpointJudge;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => Boolean(value && typeof value === "object" && !Array.isArray(value));

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boundedError(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value ?? "Unknown Treg error"); }
    catch { text = String(value ?? "Unknown Treg error"); }
  }
  return text.replace(/[\r\n]+/g, " ").slice(0, 500);
}

class TregRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly recovery?: { balanceUsd?: number; estimatedCostUsd?: number; topupUrl?: string; alternatives?: string[]; resetsAt?: string },
  ) {
    super(message);
    this.name = "TregRequestError";
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return isObject(error) && error.name === "AbortError";
}

function numberArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 120)).filter(Boolean).slice(0, 50);
  return values.length ? values : undefined;
}

function unwrapEndpoint(raw: unknown): JsonObject {
  let current: unknown = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isObject(current)) return {};
    const object = current;
    if (object.id !== undefined || object.endpoint_id !== undefined || object.slug !== undefined) return object;
    const nested = ["endpoint", "endpoint_data", "tool", "result", "data", "details"]
      .map((key) => object[key])
      .find((value) => isObject(value));
    if (!nested) return current;
    current = nested;
  }
  return isObject(current) ? current : {};
}

function normalizeHit(raw: unknown): TregEndpointHit {
  const row = unwrapEndpoint(raw);
  const cost = isObject(row.cost) ? row.cost : {};
  const observed = isObject(row.observed) ? row.observed : {};
  const input = isObject(row.input) ? row.input : {};
  const inputBody = isObject(input.body) ? input.body : {};
  const inputFields = Object.keys(inputBody).slice(0, 50);
  const id = String(row.id ?? row.endpoint_id ?? row.slug ?? "").trim();
  if (!id) throw new Error("Treg returned an endpoint without an id");
  const rawPrice = numberOrUndefined(row.price_usd ?? row.price ?? row.unit_price ?? cost.usd ?? cost.value);
  const rawPriceType = String(cost.type ?? row.price_type ?? row.cost_type ?? "").trim().toLowerCase();
  const priceType = ["per_call", "per_success", "per_result"].includes(rawPriceType)
    ? rawPriceType as NonNullable<TregEndpointHit["priceType"]>
    : rawPriceType ? "unknown" : undefined;
  const rawPriceUnit = String(cost.unit ?? row.price_unit ?? "").trim().toLowerCase();
  const priceUnit = ["call", "result", "row", "target", "domain", "keyword"].includes(rawPriceUnit)
    ? rawPriceUnit as NonNullable<TregEndpointHit["priceUnit"]>
    : "unknown";
  const priceVaries = cost.varies === true || row.price_varies === true;
  return {
    id,
    title: String(row.title ?? row.name ?? id).slice(0, 240),
    provider: String(row.provider ?? row.platform ?? "unknown").slice(0, 120),
    category: mapCategory(row),
    ...(typeof row.method === "string" && row.method.trim() ? { method: row.method.trim().toUpperCase().slice(0, 16) } : {}),
    ...(!priceVaries && rawPrice !== undefined ? { priceUsd: rawPrice } : {}),
    ...(priceType ? { priceType } : {}),
    priceUnit,
    ...(priceVaries ? { priceVaries: true } : {}),
    ...(priceVaries && rawPrice !== undefined ? { priceReferenceUsd: rawPrice } : {}),
    successRate: numberOrUndefined(row.success_rate ?? observed.ok_rate),
    latencyMs: numberOrUndefined(row.latency_ms ?? row.median_ms ?? observed.p50_ms),
    requiresOwnAccount: Boolean(row.requires_own_account ?? row.oauth),
    requiresByok: Boolean(row.requires_byok ?? row.byok_only),
    strictQuery: row.strict_query === true,
    ...(inputFields.length ? { inputFields } : numberArray(row.input_fields ?? row.required_fields ?? row.parameters) ? { inputFields: numberArray(row.input_fields ?? row.required_fields ?? row.parameters) } : {}),
    ...(numberArray(row.siblings) ? { siblings: numberArray(row.siblings) } : {}),
  };
}

function companySearchCostEstimate(metadata: TregEndpointHit, limit: number, routeCapUsd: number): number | undefined {
  if (metadata.priceVaries) {
    return metadata.priceType && metadata.priceType !== "unknown" ? routeCapUsd : undefined;
  }
  const priceUsd = metadata.priceUsd;
  if (priceUsd === undefined || priceUsd < 0 || metadata.priceType === "unknown") return undefined;
  if (metadata.priceType === "per_result") {
    if (metadata.priceUnit === "row" || metadata.priceUnit === "result") return priceUsd * limit;
    if (metadata.priceUnit === "target" || metadata.priceUnit === "domain" || metadata.priceUnit === "keyword") return priceUsd;
    return undefined;
  }
  if (metadata.priceType === "per_call" || metadata.priceType === "per_success") {
    return metadata.priceUnit === "call" ? priceUsd : undefined;
  }
  // Compatibility for older flat catalog entries that did not expose cost.type.
  if (metadata.priceUnit === "row" || metadata.priceUnit === "result") return priceUsd * limit;
  if (["call", "target", "domain", "keyword"].includes(metadata.priceUnit ?? "")) return priceUsd;
  return undefined;
}

function normalizePlatform(raw: unknown): TregPlatformOption | undefined {
  if (!isObject(raw)) return undefined;
  const id = String(raw.id ?? raw.slug ?? raw.endpoint_id ?? "").trim();
  if (!id) return undefined;
  return {
    id: id.slice(0, 200),
    title: String(raw.title ?? raw.name ?? id).slice(0, 240),
    provider: String(raw.provider ?? raw.platform ?? "unknown").slice(0, 120),
    ...(numberOrUndefined(raw.price_usd ?? raw.price ?? raw.unit_price) !== undefined ? { priceUsd: numberOrUndefined(raw.price_usd ?? raw.price ?? raw.unit_price) } : {}),
    ...(numberOrUndefined(raw.success_rate) !== undefined ? { successRate: numberOrUndefined(raw.success_rate) } : {}),
    ...(numberOrUndefined(raw.latency_ms ?? raw.median_ms) !== undefined ? { latencyMs: numberOrUndefined(raw.latency_ms ?? raw.median_ms) } : {}),
    ...(typeof raw.last_ok_at === "string" ? { lastOkAt: raw.last_ok_at.slice(0, 80) } : {}),
    ...(typeof raw.endpoint_id === "string" ? { endpointId: raw.endpoint_id.slice(0, 200) } : {}),
    ...(raw.requires_own_account === true ? { requiresOwnAccount: true } : {}),
  };
}

function normalizeOwnTool(raw: unknown): TregOwnTool | undefined {
  if (!isObject(raw)) return undefined;
  const name = String(raw.name ?? raw.id ?? "").trim();
  if (!name) return undefined;
  const bindings = isObject(raw.bindings)
    ? Object.keys(raw.bindings).slice(0, 40).map((key) => key.slice(0, 120))
    : numberArray(raw.bindings);
  return {
    name: name.slice(0, 160),
    ...(typeof raw.base_url === "string" ? { baseUrl: raw.base_url.slice(0, 500) } : {}),
    ...(typeof raw.host === "string" ? { host: raw.host.slice(0, 240) } : {}),
    ...(bindings ? { bindings } : {}),
  };
}

function mapCategory(raw: JsonObject): TregCategory {
  const value = `${String(raw.category ?? "")} ${String(raw.title ?? "")} ${String(raw.id ?? "")}`.toLowerCase();
  if (/email|person|people|hunter|apollo/.test(value)) return "enrichment_person";
  if (/company|companies|firm|firmographic|crunchbase|domain/.test(value)) return "enrichment_company";
  if (/backlink|keyword|seo|semrush|moz/.test(value)) return "seo";
  if (/tiktok|instagram|twitter|social/.test(value)) return "social_intel";
  if (/ads? library|facebook ads|google ads/.test(value)) return "ads_intel";
  if (/scrape|serp|web/.test(value)) return "web_data";
  return "other";
}

function payloadRows(data: unknown, depth = 0): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObject(data) || depth >= 4) return [];
  for (const key of ["results", "endpoints", "tools", "platforms", "orgs", "items", "rows", "members", "data"]) if (Array.isArray(data[key])) return data[key] as unknown[];
  for (const key of ["data", "result", "response"]) if (isObject(data[key])) {
    const nested = payloadRows(data[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function evidenceValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return (JSON.stringify(value) ?? String(value)).slice(0, 2000);
}

function sanitizeProviderResult(value: unknown, depth = 0, budget: { nodes: number; characters: number } = { nodes: 0, characters: 0 }): unknown {
  budget.nodes += 1;
  if (budget.nodes > 5_000 || budget.characters >= 44_000) return "[result truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const safe = value.slice(0, Math.min(4_000, 44_000 - budget.characters))
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk|rk|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{16,}/gi, "[redacted credential]")
      .replace(/([?&](?:access_token|refresh_token|token|api_key|password|signature|sig)=)[^&#\s]+/gi, "$1[redacted]");
    budget.characters += safe.length;
    return safe;
  }
  if (depth >= 5) return "[nested result omitted]";
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeProviderResult(item, depth + 1, budget));
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:secret|token|password|authorization|credential|api[_-]?key)/i.test(key))
    .slice(0, 50)
    .map(([key, item]) => [key.slice(0, 120), sanitizeProviderResult(item, depth + 1, budget)]));
}

function providerScore(row: Record<string, unknown>): number | undefined {
  for (const key of ["provider_score", "match_score", "confidence", "confidence_score", "match_confidence"]) {
    const value = row[key];
    const score = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(score) || score < 0) continue;
    // Providers commonly return either a 0..1 score or a percentage.
    if (score <= 1) return score;
    if (score <= 100) return score / 100;
  }
  return undefined;
}

function evidence(field: string, value: unknown, hit: TregEndpointHit, score?: number): TregEvidenceItem | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return {
    field,
    value: evidenceValue(value),
    ...(score === undefined ? {} : { providerScore: score }),
    sourceEndpoint: hit.id,
    sourceProvider: hit.provider,
    observedAt: new Date().toISOString(),
  };
}

function providerPayload(result: unknown): unknown {
  if (!isObject(result)) return result;
  if (isObject(result.output)) return result.output;
  if (isObject(result.data)) return result.data;
  return result;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function resultRows(result: unknown, keys: string[]): JsonObject[] {
  const payload = providerPayload(result);
  const rows = Array.isArray(payload) ? payload : isObject(payload)
    ? keys.map((key) => payload[key]).find(Array.isArray) as unknown[] | undefined
    : undefined;
  return (rows ?? []).filter(isObject).slice(0, 25);
}

function sourceUrls(row: JsonObject): string[] | undefined {
  const values = [row.source_url, row.url, ...(Array.isArray(row.source_urls) ? row.source_urls : []), ...(Array.isArray(row.sources) ? row.sources : [])];
  const urls = [...new Set(values.map(httpsUrl).filter((value): value is string => Boolean(value)))].slice(0, 5);
  return urls.length ? urls : undefined;
}

function routeMetadata(result: unknown): { servedBy?: string; tried?: string[]; ignoredFilters?: string[]; pending: boolean } {
  const payload = isObject(result) ? result : {};
  const route = isObject(payload._treg) ? payload._treg : {};
  return {
    ...(typeof route.served_by === "string" ? { servedBy: route.served_by.slice(0, 120) } : {}),
    ...(Array.isArray(route.tried) ? { tried: route.tried.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 120)) } : {}),
    ...(Array.isArray(route.ignored_filters) ? { ignoredFilters: route.ignored_filters.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 120)) } : {}),
    pending: route.outcome === "pending" || payload.outcome === "pending",
  };
}

function normalizePersonSearchRow(row: JsonObject): TregPersonSearchResult {
  const verified = row.email_verified ?? row.verified;
  const status = row.email_verification_status ?? row.verification_status ?? row.email_status;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : "";
  const emailVerified = typeof verified === "boolean" ? verified
    : ["verified", "valid", "deliverable"].includes(normalizedStatus) ? true
      : ["invalid", "undeliverable", "bounced"].includes(normalizedStatus) ? false
        : undefined;
  const employeeEmail = row.email ?? row.work_email;
  const score = providerScore(row);
  return {
    ...(typeof (row.full_name ?? row.name) === "string" ? { fullName: String(row.full_name ?? row.name).slice(0, 240) } : {}),
    ...(typeof (row.title ?? row.job_title ?? row.headline) === "string" ? { title: String(row.title ?? row.job_title ?? row.headline).slice(0, 240) } : {}),
    ...(typeof (row.company ?? row.company_name ?? row.organization) === "string" ? { company: String(row.company ?? row.company_name ?? row.organization).slice(0, 240) } : {}),
    ...(typeof (row.domain ?? row.company_domain) === "string" ? { domain: String(row.domain ?? row.company_domain).slice(0, 240) } : {}),
    ...(httpsUrl(row.linkedin_url ?? row.profile_url ?? row.linkedin) ? { linkedinUrl: httpsUrl(row.linkedin_url ?? row.profile_url ?? row.linkedin) } : {}),
    ...(typeof (row.location ?? row.country) === "string" ? { location: String(row.location ?? row.country).slice(0, 160) } : {}),
    ...(typeof employeeEmail === "string" && employeeEmail.includes("@") ? { email: employeeEmail.slice(0, 320), ...(typeof status === "string" ? { emailVerificationStatus: status.slice(0, 80) } : {}), ...(emailVerified === undefined ? {} : { emailVerified }) } : {}),
    ...(sourceUrls(row) ? { sourceUrls: sourceUrls(row) } : {}),
    ...(score === undefined ? {} : { providerScore: score }),
  };
}

function normalizeCompanySearchRow(row: JsonObject): TregCompanySearchResult {
  const count = numberOrUndefined(row.employee_count ?? row.employees);
  const score = providerScore(row);
  return {
    ...(typeof (row.name ?? row.company ?? row.company_name) === "string" ? { name: String(row.name ?? row.company ?? row.company_name).slice(0, 240) } : {}),
    ...(typeof (row.domain ?? row.website) === "string" ? { domain: String(row.domain ?? row.website).slice(0, 240) } : {}),
    ...(typeof row.industry === "string" ? { industry: row.industry.slice(0, 200) } : {}),
    ...(count !== undefined && Number.isSafeInteger(count) && count >= 0 ? { employeeCount: count } : {}),
    ...(typeof (row.location ?? row.country) === "string" ? { location: String(row.location ?? row.country).slice(0, 160) } : {}),
    ...(typeof row.description === "string" ? { description: row.description.slice(0, 1000) } : {}),
    ...(sourceUrls(row) ? { sourceUrls: sourceUrls(row) } : {}),
    ...(score === undefined ? {} : { providerScore: score }),
  };
}

function canonicalCompanyDomain(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const candidate = value.trim();
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

function normalizeCompanyJobRow(row: JsonObject): TregCompanyJobResult {
  const jobUrl = httpsUrl(row.job_url ?? row.url ?? row.apply_url);
  const urls = sourceUrls(row) ?? (jobUrl ? [jobUrl] : undefined);
  const score = providerScore(row);
  return {
    signalType: "hiring",
    ...(typeof (row.company_name ?? row.company ?? row.organization) === "string" ? { companyName: String(row.company_name ?? row.company ?? row.organization).slice(0, 240) } : {}),
    ...(typeof (row.company_domain ?? row.domain) === "string" ? { companyDomain: String(row.company_domain ?? row.domain).slice(0, 240) } : {}),
    ...(typeof (row.title ?? row.job_title ?? row.position) === "string" ? { title: String(row.title ?? row.job_title ?? row.position).slice(0, 240) } : {}),
    ...(typeof (row.location ?? row.location_name ?? row.country) === "string" ? { location: String(row.location ?? row.location_name ?? row.country).slice(0, 160) } : {}),
    ...(typeof (row.posted_at ?? row.date_posted ?? row.created_at) === "string" ? { postedAt: String(row.posted_at ?? row.date_posted ?? row.created_at).slice(0, 80) } : {}),
    ...(jobUrl ? { jobUrl } : {}),
    ...(urls ? { sourceUrls: urls } : {}),
    ...(typeof row.description === "string" ? { description: row.description.slice(0, 1000) } : {}),
    ...(score === undefined ? {} : { providerScore: score }),
  };
}

function normalizePersonPayload(result: unknown, hit: TregEndpointHit): TregEvidenceItem[] {
  const payload = providerPayload(result);
  const row = isObject(payload) ? payload : {};
  const score = providerScore(row);
  const items = [
    evidence("email", row.email ?? row.work_email ?? row.value, hit, score),
    evidence("email_verified", row.email_verified ?? row.verified, hit, score),
    evidence("email_verification_status", row.email_verification_status ?? row.verification_status ?? row.email_status, hit, score),
    evidence("full_name", row.name ?? row.full_name, hit, score),
    evidence("title", row.title ?? row.job_title, hit, score),
    evidence("linkedin_url", row.linkedin ?? row.linkedin_url, hit, score),
    evidence("company", row.company ?? row.organization, hit, score),
    evidence("domain", row.domain, hit, score),
    evidence("source_url", httpsUrl(row.source_url ?? row.url), hit, score),
  ].filter((item): item is TregEvidenceItem => Boolean(item));
  if (!items.length && result !== null && typeof result === "object") {
    const raw = evidence("raw", result, hit, score);
    if (raw) items.push(raw);
  }
  return items;
}

function normalizeCompanyPayload(result: unknown, hit: TregEndpointHit): TregEvidenceItem[] {
  const payload = providerPayload(result);
  const row = isObject(payload) ? payload : {};
  const score = providerScore(row);
  return [
    evidence("company_name", row.name ?? row.company, hit, score),
    evidence("domain", row.domain ?? row.website, hit, score),
    evidence("industry", row.industry, hit, score),
    evidence("employee_count", row.employees ?? row.employee_count, hit, score),
    evidence("description", row.description, hit, score),
  ].filter((item): item is TregEvidenceItem => Boolean(item));
}

function coerceEvidence(result: unknown, hit: TregEndpointHit): TregEvidenceItem[] {
  if (Array.isArray(result)) return result.flatMap((row) => coerceEvidence(row, hit)).slice(0, 25);
  return [...normalizePersonPayload(result, hit), ...normalizeCompanyPayload(result, hit)];
}

function dedupeEvidence(items: TregEvidenceItem[]): TregEvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.field}:${String(item.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyBundle(query: string, intent: string, warnings: string[]): TregEvidenceBundle {
  return { query, intent, items: [], endpointsUsed: [], totalCostUsd: 0, warnings, incomplete: true, generatedAt: new Date().toISOString() };
}

export function rankHits(hits: TregEndpointHit[], intent: string, maxSpendUsd?: number, availableFields?: string[], fit?: Record<string, number>): TregEndpointHit[] {
  const query = intent.toLowerCase();
  const semantic = fit && Object.keys(fit).length ? fit : undefined;
  return [...hits].sort((a, b) => {
    const score = (hit: TregEndpointHit): number => {
      // With a semantic fit distribution, it replaces the keyword category
      // boost (up to 80 points); economics and input coverage still apply.
      const categoryBoost = semantic ? Math.max(0, Math.min(1, semantic[hit.id] ?? 0)) * 80 : query.includes("person") && hit.category === "enrichment_person" || query.includes("company") && hit.category === "enrichment_company" || query.includes("seo") && hit.category === "seo" || query.includes("social") && hit.category === "social_intel" || query.includes("ads") && hit.category === "ads_intel" || query.includes("web") && hit.category === "web_data" ? 50 : 0;
      const affordable = hit.priceVaries ? 0 : hit.priceUsd === undefined || maxSpendUsd === undefined || hit.priceUsd <= maxSpendUsd ? 20 : -100;
      const reliability = hit.successRate === undefined ? 0 : Math.max(0, Math.min(1, hit.successRate)) * 20;
      const latency = hit.latencyMs === undefined ? 0 : Math.max(-10, 10 - hit.latencyMs / 1000);
      const price = hit.priceVaries || hit.priceUsd === undefined ? -5 : Math.max(-10, 5 - hit.priceUsd * 10);
      const compatibility = availableFields?.length && hit.inputFields?.length
        ? hit.inputFields.filter((field) => availableFields.includes(field)).length / hit.inputFields.length * 40
        : 0;
      return categoryBoost + affordable + reliability + latency + price + compatibility + (hit.requiresOwnAccount || hit.requiresByok ? -40 : 0);
    };
    return score(b) - score(a);
  });
}

function safeResultHash(result: unknown): string {
  return createHash("sha256").update((JSON.stringify(result) ?? String(result)).slice(0, 50_000)).digest("hex");
}

function sanitizeConnection(raw: unknown): TregOAuthConnection | undefined {
  if (!isObject(raw)) return undefined;
  const id = String(raw.id ?? raw.secret_id ?? raw.connection_id ?? "").trim();
  if (!id) return undefined;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 50) : undefined;
  return { id: id.slice(0, 200), ...(typeof raw.provider === "string" ? { provider: raw.provider.slice(0, 120) } : {}), ...(typeof raw.name === "string" ? { name: raw.name.slice(0, 200) } : {}), ...(typeof raw.status === "string" ? { status: raw.status.slice(0, 80) } : {}), ...(scopes ? { scopes } : {}) };
}

export class TregGateway {
  private readonly base = config.tregBaseUrl.replace(/\/$/, "");
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private async rank(hits: TregEndpointHit[], intent: string, need: string, maxSpendUsd?: number, availableFields?: string[], requiredFields?: string[]): Promise<TregEndpointHit[]> {
    const unique = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
    let fit: Record<string, number> | undefined;
    if (this.deps.judge && unique.length > 1) {
      try { fit = await this.deps.judge({ intent, need, hits: unique, availableFields, requiredFields }); } catch { fit = undefined; }
    }
    return rankHits(unique, intent, maxSpendUsd, availableFields, fit);
  }

  constructor(private readonly deps: TregGatewayDeps) {
    if (!config.tregEnabled) throw new Error("Treg is disabled");
    if (!config.tregToken && !Object.keys(config.tregOrganizationTokens).length) throw new Error("TREG_TOKEN or TREG_ORG_TOKENS_JSON is not configured");
    this.fetcher = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private credential(organizationId?: string): { token: string; tregOrgId?: string } {
    if (organizationId && !/^org_[A-Za-z0-9_-]{1,120}$/.test(organizationId)) throw new Error("Invalid Treg organization scope");
    const scoped = organizationId ? config.tregOrganizationTokens[organizationId] : undefined;
    const token = organizationId ? scoped?.token : config.tregToken;
    if (!token) throw new Error(`No Treg credential is configured for ${organizationId ?? "the default account"}`);
    return { token, tregOrgId: scoped?.tregOrgId };
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>, idempotencyKey?: string, organizationId?: string, tregRoute?: { maxCostUsd?: number; verify?: boolean }): Promise<{ data: T; status: number; durationMs: number; meta: { callId?: string; costUsd?: number; replayed?: boolean; servedVia?: string; servedBy?: string; ignoredFilters?: string[]; upstreamFailed?: string } }> {
    const upper = method.toUpperCase();
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const retryableMethod = ["GET", "HEAD", "OPTIONS"].includes(upper) || Boolean(idempotencyKey);
    const credential = this.credential(organizationId);
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.tregMaxRetries; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.tregTimeoutMs);
      try {
        const response = await this.fetcher(url.toString(), {
          method: upper,
          headers: { accept: "application/json", "content-type": "application/json", "X-Treg-Token": credential.token, ...(credential.tregOrgId ? { "x-treg-org": credential.tregOrgId } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...(tregRoute?.maxCostUsd !== undefined ? { "X-Treg-Route-Max-Cost": tregRoute.maxCostUsd.toFixed(6) } : {}), ...(tregRoute?.verify ? { "X-Treg-Route-Verify": "true" } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const durationMs = Date.now() - started;
        const text = await response.text();
        let data: unknown = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
        const errorCode = isObject(data) && typeof data.error === "string" ? data.error : undefined;
        const transient = [408, 425, 429].includes(response.status) || (response.status >= 500 && !(response.status === 503 && errorCode === "provider_capacity_unavailable") && !(response.status === 502 && errorCode === "response_buffer_limit"));
        if (retryableMethod && transient) {
          if (attempt < config.tregMaxRetries) {
            lastError = new Error(`Treg upstream ${response.status}`);
            await this.sleep(Math.min(1000, 100 * 2 ** attempt));
            continue;
          }
        }
        if (!response.ok) {
          const detail = isObject(data) ? data.detail ?? data.message ?? data.error : text;
          const recovery = isObject(data) ? {
            ...(numberOrUndefined(data.balance_micro) !== undefined ? { balanceUsd: Number(data.balance_micro) / 1_000_000 } : {}),
            ...(numberOrUndefined(data.estimated_cost_micro) !== undefined ? { estimatedCostUsd: Number(data.estimated_cost_micro) / 1_000_000 } : {}),
            ...(typeof data.topup_url === "string" && /^https:\/\//i.test(data.topup_url) ? { topupUrl: data.topup_url.slice(0, 500) } : {}),
            ...(Array.isArray(data.alternatives) ? { alternatives: data.alternatives.filter((item): item is string => typeof item === "string").slice(0, 10) } : {}),
            ...(typeof data.resets_at === "string" ? { resetsAt: data.resets_at.slice(0, 80) } : {}),
          } : undefined;
          const suffix = recovery?.topupUrl ? ` Top up at ${recovery.topupUrl}.` : recovery?.alternatives?.length ? ` Alternatives: ${recovery.alternatives.join(", ")}.` : recovery?.resetsAt ? ` Provider capacity may recover at ${recovery.resetsAt}.` : "";
          throw new TregRequestError(`Treg ${upper} ${path} failed (${response.status})${errorCode ? ` ${errorCode}` : ""}: ${boundedError(detail)}.${suffix}`, response.status, errorCode, recovery);
        }
        const costMicro = numberOrUndefined(response.headers.get("X-Treg-Cost-Micro"));
        const ignoredFiltersHeader = response.headers.get("X-Treg-Ignored-Filters");
        const ignoredFilters = ignoredFiltersHeader?.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20);
        const upstreamFailed = response.headers.get("X-Treg-Upstream-Failed")?.slice(0, 240);
        return {
          data: data as T,
          status: response.status,
          durationMs,
          meta: {
            ...(response.headers.get("X-Treg-Call-Id") ? { callId: response.headers.get("X-Treg-Call-Id") ?? undefined } : {}),
            ...(costMicro !== undefined ? { costUsd: costMicro / 1_000_000 } : {}),
            ...(response.headers.get("X-Treg-Idempotent-Replay") === "true" ? { replayed: true } : {}),
            ...(response.headers.get("X-Treg-Served-Via") ? { servedVia: response.headers.get("X-Treg-Served-Via") ?? undefined } : {}),
            ...(response.headers.get("X-Treg-Served-By") ? { servedBy: response.headers.get("X-Treg-Served-By") ?? undefined } : {}),
            ...(ignoredFilters?.length ? { ignoredFilters } : {}),
            ...(upstreamFailed ? { upstreamFailed } : {}),
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt < config.tregMaxRetries && retryableMethod && isRetryableNetworkError(error)) {
          await this.sleep(Math.min(1000, 100 * 2 ** attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Treg request failed");
  }

  async search(q: string, limit = 8, organizationId?: string): Promise<TregEndpointHit[]> {
    const data = await this.request<unknown>("GET", "/catalog/search", undefined, { q, limit: Math.min(15, Math.max(1, limit)) }, undefined, organizationId);
    return payloadRows(data.data).slice(0, limit).flatMap((row) => { try { return [normalizeHit(row)]; } catch { return []; } });
  }

  async getEndpoint(endpointId: string, organizationId?: string): Promise<TregEndpointHit> {
    const result = await this.request<unknown>("GET", `/catalog/endpoints/${encodeURIComponent(endpointId)}`, undefined, undefined, undefined, organizationId);
    return normalizeHit(result.data);
  }

  async platforms(slug: string, organizationId?: string): Promise<TregPlatformOption[]> {
    const cleanSlug = slug.trim().replace(/^\/+|\/+$/g, "");
    if (!cleanSlug || cleanSlug.length > 200 || /[?#]/.test(cleanSlug)) throw new Error("Invalid Treg platform slug");
    const result = await this.request<unknown>("GET", `/catalog/platforms/${encodeURIComponent(cleanSlug)}`, undefined, undefined, undefined, organizationId);
    return payloadRows(result.data).map(normalizePlatform).filter((item): item is TregPlatformOption => Boolean(item)).slice(0, 50);
  }

  async myTools(organizationId?: string): Promise<TregOwnTool[]> {
    const result = await this.request<unknown>("GET", "/tools", undefined, undefined, undefined, organizationId);
    return payloadRows(result.data).map(normalizeOwnTool).filter((item): item is TregOwnTool => Boolean(item)).slice(0, 100);
  }

  /** Run one explicitly registered Treg customer-management operation. */
  async manage(action: string, args: Record<string, unknown>, organizationId?: string, idempotencyKey?: string): Promise<unknown> {
    const request = buildTregAdminRequest(action, args);
    if (request.orgId) {
      const listed = await this.request<unknown>("GET", "/orgs", undefined, undefined, undefined, organizationId);
      const rows = payloadRows(listed.data);
      const accessible = rows.some((row) => {
        if (!isObject(row)) return false;
        return String(row.id ?? row.org_id ?? row.orgId ?? "") === request.orgId;
      });
      if (!accessible) throw new Error("That Treg organization is not available to this authenticated account.");
    }
    const result = await this.request<unknown>(request.method, request.path, request.body,
      request.query ? Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key, String(value)])) : undefined,
      request.isRead ? undefined : idempotencyKey, organizationId);
    const safeData = sanitizeTregAdminResult(result.data);
    let data = safeData;
    try {
      const serialized = JSON.stringify(safeData);
      if (serialized && Buffer.byteLength(serialized, "utf8") > 48_000) {
        data = { truncated: true, preview: serialized.slice(0, 40_000), note: "Response was bounded to protect private context; use a more specific query if available." };
      }
    } catch {
      data = { note: "Treg returned a result that could not be safely summarized." };
    }
    return { action, statusCode: result.status, data };
  }

  async searchPeople(options: { userId: number; query?: string; companyDomain?: string; title?: string; country?: string; limit?: number; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<{ query: string; people: TregPersonSearchResult[]; endpoint: string; callId: string; servedBy?: string; tried?: string[]; totalCostUsd: number; warnings: string[]; incomplete: boolean; generatedAt: string }> {
    const endpoint = "treg.people.search";
    const query = [options.query, options.companyDomain ? `company domain ${options.companyDomain}` : "", options.title ? `title ${options.title}` : "", options.country ? `country ${options.country}` : ""].filter(Boolean).join("; ").slice(0, 1000);
    if (!query) throw new Error("Provide a people-search description, company domain, job title, or country.");
    const maxSpendUsd = options.maxSpendUsd ?? config.tregPerCallSoftCapUsd;
    const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 10)));
    await this.getEndpoint(endpoint, options.organizationId);
    const body = { ...(options.query ? { query: options.query.slice(0, 800) } : {}), ...(options.companyDomain ? { company_domain: options.companyDomain.slice(0, 240) } : {}), ...(options.title ? { title: options.title.slice(0, 240) } : {}), ...(options.country ? { country: options.country.slice(0, 120) } : {}), limit };
    const response = await this.call({ userId: options.userId, endpointId: endpoint, method: "POST", body, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: maxSpendUsd, routeMaxCostUsd: maxSpendUsd });
    const route = routeMetadata(response.result);
    const people = resultRows(response.result, ["people", "results", "items"]).map(normalizePersonSearchRow);
    const warnings = [
      ...(route.pending || response.receipt.pending ? ["Treg is still processing this search. Do not retry it yet; inspect the existing Treg call before starting another search."] : []),
      ...(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length ? [`Treg reports filters it could not apply: ${(route.ignoredFilters ?? response.receipt.ignoredFilters ?? []).join(", ")}. Review returned rows against the requested constraints.`] : []),
      ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []),
      ...(people.some((person) => person.email && person.emailVerified !== true) ? ["Email addresses without explicit verified status are not treated as verified; verify before outreach."] : []),
      ...(!people.length && !route.pending && !response.receipt.pending ? ["No people matched the routed search inputs."] : []),
    ];
    return { query, people, endpoint, callId: response.receipt.callId, ...(route.servedBy || response.receipt.servedBy ? { servedBy: route.servedBy ?? response.receipt.servedBy } : {}), ...((route.tried ?? response.receipt.routeTried)?.length ? { tried: route.tried ?? response.receipt.routeTried } : {}), totalCostUsd: response.receipt.costUsd, warnings, incomplete: route.pending || response.receipt.pending === true || Boolean(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length), generatedAt: new Date().toISOString() };
  }

  async searchCompanies(options: { userId: number; query?: string; name?: string; domain?: string; industry?: string; technology?: string; country?: string; limit?: number; missionId?: string; maxSpendUsd?: number; idempotencyKey?: string; organizationId?: string }): Promise<{ query: string; companies: TregCompanySearchResult[]; endpoint: string; callId: string; servedBy?: string; tried?: string[]; totalCostUsd: number; warnings: string[]; incomplete: boolean; generatedAt: string }> {
    const endpoint = "treg.companies.search";
    type CompanySearchIdentityField = "query" | "name" | "domain" | "industry" | "technology";
    const identityInputs: readonly (readonly [CompanySearchIdentityField, string | undefined])[] = [
      ["query", options.query?.trim().slice(0, 800)],
      ["name", options.name?.trim().slice(0, 240)],
      ["domain", options.domain?.trim().slice(0, 240)],
      ["industry", options.industry?.trim().slice(0, 200)],
      ["technology", options.technology?.trim().slice(0, 160)],
    ];
    const identities = identityInputs.filter((entry): entry is readonly [CompanySearchIdentityField, string] => Boolean(entry[1]));
    if (!identities.length) throw new Error("Provide one company-search identity: query, name, domain, industry, or technology. A country filter alone is not enough.");
    const country = options.country?.trim().slice(0, 120) || undefined;
    const query = [
      ...identities.map(([kind, value]) => kind === "query" && identities.length === 1 ? value : `${kind}: ${value}`),
      ...(country ? [`country: ${country}`] : []),
    ].join("; ").slice(0, 1000);
    const maxSpendUsd = options.maxSpendUsd ?? config.tregPerCallSoftCapUsd;
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0) throw new Error("Treg company-search maxSpendUsd must be a finite non-negative amount.");
    const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 10)));
    const metadata = await this.getEndpoint(endpoint, options.organizationId);
    if (metadata.id !== endpoint) throw new Error("Treg company-search catalog identity did not match; no provider call was made.");
    const estimatedCostUsd = companySearchCostEstimate(metadata, limit, maxSpendUsd);
    if (estimatedCostUsd === undefined || !Number.isFinite(estimatedCostUsd)) throw new Error("Treg company-search price unit is unknown; no provider call was made.");
    if (estimatedCostUsd > maxSpendUsd) throw new Error(`Treg company-search estimate $${estimatedCostUsd.toFixed(6)} exceeds the $${maxSpendUsd.toFixed(6)} limit; no provider call was made.`);
    const identityBody: JsonObject = identities.length === 1
      ? { [identities[0][0] === "query" ? "q" : identities[0][0]]: identities[0][1] }
      : { q: identities.map(([kind, value]) => `${kind}: ${value}`).join("; ").slice(0, 800) };
    const body = { ...identityBody, ...(country ? { country } : {}), limit };
    const response = await this.call({ userId: options.userId, endpointId: endpoint, method: "POST", body, missionId: options.missionId, organizationId: options.organizationId, endpointMetadata: metadata, estimateUsd: estimatedCostUsd, routeMaxCostUsd: maxSpendUsd, idempotencyKey: options.idempotencyKey });
    const route = routeMetadata(response.result);
    const providerCompanies = resultRows(response.result, ["companies", "results", "items"]).map(normalizeCompanySearchRow);
    const requestedDomain = canonicalCompanyDomain(options.domain);
    const identityMismatches = requestedDomain
      ? providerCompanies.filter((company) => canonicalCompanyDomain(company.domain) !== requestedDomain).length
      : 0;
    const companies = requestedDomain
      ? providerCompanies.filter((company) => canonicalCompanyDomain(company.domain) === requestedDomain)
      : providerCompanies;
    const warnings = [
      ...(route.pending || response.receipt.pending ? ["Treg is still processing this search. Do not retry it yet; inspect the existing Treg call before starting another search."] : []),
      ...(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length ? [`Treg reports filters it could not apply: ${(route.ignoredFilters ?? response.receipt.ignoredFilters ?? []).join(", ")}. Review returned rows against the requested constraints.`] : []),
      ...(identityMismatches ? [`Treg returned ${identityMismatches} company record(s) without an exact match to the requested domain; those rows were excluded.`] : []),
      ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []),
      ...(!companies.length && !route.pending && !response.receipt.pending ? ["No companies matched the routed search inputs."] : []),
    ];
    return { query, companies, endpoint, callId: response.receipt.callId, ...(route.servedBy || response.receipt.servedBy ? { servedBy: route.servedBy ?? response.receipt.servedBy } : {}), ...((route.tried ?? response.receipt.routeTried)?.length ? { tried: route.tried ?? response.receipt.routeTried } : {}), totalCostUsd: response.receipt.costUsd, warnings, incomplete: route.pending || response.receipt.pending === true || identityMismatches > 0 || Boolean(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length), generatedAt: new Date().toISOString() };
  }

  async searchCompanyJobs(options: { userId: number; name?: string; domain?: string; limit?: number; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<{ query: string; jobs: TregCompanyJobResult[]; endpoint: string; callId: string; servedBy?: string; tried?: string[]; totalCostUsd: number; warnings: string[]; incomplete: boolean; generatedAt: string }> {
    const name = options.name?.trim().slice(0, 240);
    const domain = options.domain?.trim().slice(0, 240);
    if (!name && !domain) throw new Error("Provide a company name or domain to search hiring signals.");
    const endpoint = "treg.companies.jobs.search";
    const query = [name ? `company ${name}` : "", domain ? `domain ${domain}` : "", "current job listings"].filter(Boolean).join("; ").slice(0, 1000);
    const maxSpendUsd = Math.min(options.maxSpendUsd ?? config.tregPerCallSoftCapUsd, config.tregPerCallSoftCapUsd);
    if (maxSpendUsd <= 0) throw new Error("A positive Treg spend limit is required for hiring-signal search.");
    const metadata = await this.getEndpoint(endpoint, options.organizationId);
    if (metadata.id !== endpoint || metadata.method !== "POST") throw new Error("Treg hiring-signal route metadata did not match the expected bounded search operation.");
    if (metadata.priceUsd !== undefined && metadata.priceUsd > maxSpendUsd) throw new Error("Treg hiring-signal route exceeds the available per-call spend limit.");
    const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 10)));
    const response = await this.call({
      userId: options.userId,
      endpointId: endpoint,
      method: "POST",
      body: { ...(name ? { name } : {}), ...(domain ? { domain } : {}), limit },
      missionId: options.missionId,
      organizationId: options.organizationId,
      estimateUsd: maxSpendUsd,
      routeMaxCostUsd: maxSpendUsd,
    });
    const route = routeMetadata(response.result);
    const jobs = resultRows(response.result, ["jobs", "results", "items", "listings"]).map(normalizeCompanyJobRow);
    const warnings = [
      ...(route.pending || response.receipt.pending ? ["Treg is still processing this hiring-signal search. Inspect the existing call before starting another search."] : []),
      ...(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length ? [`Treg reports filters it could not apply: ${(route.ignoredFilters ?? response.receipt.ignoredFilters ?? []).join(", ")}. Review returned listings against the requested company.`] : []),
      ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []),
      ...(!jobs.length && !route.pending && !response.receipt.pending ? ["No current job listings matched the company inputs; this is not evidence that the company is not hiring."] : []),
      ...(jobs.some((job) => !job.postedAt || !job.sourceUrls?.length && !job.jobUrl) ? ["Some listings lack a posting date or source link; treat those rows as lower-quality evidence."] : []),
    ];
    return { query, jobs, endpoint, callId: response.receipt.callId, ...(route.servedBy || response.receipt.servedBy ? { servedBy: route.servedBy ?? response.receipt.servedBy } : {}), ...((route.tried ?? response.receipt.routeTried)?.length ? { tried: route.tried ?? response.receipt.routeTried } : {}), totalCostUsd: response.receipt.costUsd, warnings, incomplete: route.pending || response.receipt.pending === true || Boolean(route.ignoredFilters?.length || response.receipt.ignoredFilters?.length), generatedAt: new Date().toISOString() };
  }

  async verifyEmail(options: { userId: number; email: string; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<{ email: string; endpoint: string; callId: string; status: string; valid: boolean | null; catchAll?: boolean; disposable?: boolean; roleAccount?: boolean; servedBy?: string; totalCostUsd: number; pending: boolean; warnings: string[] }> {
    const email = options.email.trim();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Provide one valid email address for verification.");
    const endpoint = "treg.people.email.verify";
    const maxSpendUsd = options.maxSpendUsd ?? config.tregPerCallSoftCapUsd;
    const response = await this.call({ userId: options.userId, endpointId: endpoint, body: { email }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: maxSpendUsd, routeMaxCostUsd: maxSpendUsd });
    const payload = providerPayload(response.result);
    const row = isObject(payload) ? payload : {};
    const nested = isObject(row.verification) ? row.verification : row;
    const rawStatus = String(nested.status ?? nested.result ?? nested.deliverability ?? "unknown").toLowerCase().slice(0, 80);
    const valid = nested.valid === true || nested.is_valid === true || ["valid", "verified", "deliverable"].includes(rawStatus)
      ? true
      : nested.valid === false || nested.is_valid === false || ["invalid", "undeliverable", "disposable", "blocked"].includes(rawStatus)
        ? false
        : null;
    const pending = response.receipt.pending === true;
    return {
      email, endpoint, callId: response.receipt.callId, status: rawStatus, valid,
      ...(nested.catch_all === true || rawStatus === "catch_all" ? { catchAll: true } : nested.catch_all === false ? { catchAll: false } : {}),
      ...(nested.disposable === true || rawStatus === "disposable" ? { disposable: true } : nested.disposable === false ? { disposable: false } : {}),
      ...(nested.role === true || nested.role_account === true ? { roleAccount: true } : {}),
      ...(response.receipt.servedBy ? { servedBy: response.receipt.servedBy } : {}),
      totalCostUsd: response.receipt.costUsd, pending,
      warnings: [
        ...(pending ? ["Treg is still processing this verification. Do not retry; inspect the existing Treg call first."] : []),
        ...(valid === null && !pending ? ["The provider returned no decisive email-validity status; keep the address in an unknown state."] : []),
        ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []),
      ],
    };
  }

  async callStatus(callIdInput: string, organizationId?: string): Promise<{ callId: string; status: string; pending: boolean; provider?: string; costUsd?: number; result?: unknown; error?: string }> {
    const callId = callIdInput.trim();
    if (!/^[A-Za-z0-9_-]{3,200}$/.test(callId)) throw new Error("Invalid Treg call ID");
    const response = await this.request<unknown>("GET", `/calls/${encodeURIComponent(callId)}`, undefined, undefined, undefined, organizationId);
    const row = isObject(response.data) ? response.data : {};
    const status = String(row.status ?? row.outcome ?? "unknown").toLowerCase().slice(0, 80);
    let result = row.result ?? row.output ?? row.data;
    if (result === undefined && ["complete", "completed", "succeeded", "success"].includes(status)) {
      const resultResponse = await this.request<unknown>("GET", `/calls/${encodeURIComponent(callId)}/result`, undefined, undefined, undefined, organizationId);
      const resultRow = isObject(resultResponse.data) ? resultResponse.data : {};
      result = resultRow.result ?? resultRow.output ?? resultResponse.data;
    }
    return {
      callId, status,
      pending: ["pending", "queued", "running", "in_progress", "processing"].includes(status),
      ...(typeof (row.provider ?? row.served_by) === "string" ? { provider: String(row.provider ?? row.served_by).slice(0, 120) } : {}),
      ...(numberOrUndefined(row.charged_micro) !== undefined ? { costUsd: Number(row.charged_micro) / 1_000_000 } : numberOrUndefined(row.cost_usd) !== undefined ? { costUsd: Number(row.cost_usd) } : {}),
      ...(result === undefined ? {} : { result: sanitizeProviderResult(result) }),
      ...(typeof row.error === "string" ? { error: boundedError(row.error) } : {}),
    };
  }

  async balance(orgId?: string, organizationId?: string): Promise<{ balanceUsd?: number; raw: unknown }> {
    const result = orgId
      ? await this.request<unknown>("GET", `/orgs/${encodeURIComponent(orgId)}/balance`, undefined, undefined, undefined, organizationId).catch(() => undefined)
      : undefined;
    const response = result ?? await this.request<unknown>("GET", "/billing", undefined, undefined, undefined, organizationId);
    const row = isObject(response.data) ? response.data : {};
    return { balanceUsd: numberOrUndefined(row.balance ?? row.available), raw: response.data };
  }

  async oauthProviders(organizationId?: string): Promise<unknown> {
    const result = await this.request<unknown>("GET", "/oauth/providers", undefined, undefined, undefined, organizationId);
    return Array.isArray(result.data) ? result.data.slice(0, 100) : result.data;
  }

  async oauthStart(provider: string, organizationId?: string): Promise<{ authorizationUrl: string; state: string; expiresAt?: number }> {
    const result = await this.request<unknown>("POST", "/oauth/start", { provider: provider.slice(0, 120) }, undefined, randomUUID(), organizationId);
    const row = isObject(result.data) ? result.data : {};
    const authorizationUrl = String(row.authorization_url ?? row.authorize_url ?? row.url ?? "").trim();
    const state = String(row.state ?? "").trim();
    if (!/^https:\/\//i.test(authorizationUrl) || !state) throw new Error("Treg returned an invalid OAuth handoff");
    const expiresAt = numberOrUndefined(row.expires_at ?? row.expiresAt);
    return { authorizationUrl, state, ...(expiresAt ? { expiresAt } : {}) };
  }

  async oauthStatus(state: string, organizationId?: string): Promise<{ status: string; provider?: string; connected?: boolean }> {
    const result = await this.request<unknown>("GET", `/oauth/status/${encodeURIComponent(state)}`, undefined, undefined, undefined, organizationId);
    const row = isObject(result.data) ? result.data : {};
    return { status: String(row.status ?? row.state ?? "unknown").slice(0, 80), ...(typeof row.provider === "string" ? { provider: row.provider.slice(0, 120) } : {}), ...(typeof row.connected === "boolean" ? { connected: row.connected } : {}) };
  }

  async oauthConnections(organizationId?: string): Promise<TregOAuthConnection[]> {
    const result = await this.request<unknown>("GET", "/connections", undefined, undefined, undefined, organizationId);
    const rows = Array.isArray(result.data) ? result.data : isObject(result.data) && Array.isArray(result.data.connections) ? result.data.connections : [];
    return rows.map(sanitizeConnection).filter((item): item is TregOAuthConnection => Boolean(item)).slice(0, 100);
  }

  async oauthRevoke(secretId: string, organizationId?: string): Promise<{ revoked: boolean; id: string }> {
    await this.request<unknown>("DELETE", `/connections/${encodeURIComponent(secretId)}`, undefined, undefined, randomUUID(), organizationId);
    return { revoked: true, id: secretId.slice(0, 200) };
  }

  async call(options: { userId: number; endpointId: string; method?: string; body?: unknown; query?: Record<string, string | number | undefined>; missionId?: string; estimateUsd?: number; routeMaxCostUsd?: number; routeVerify?: boolean; organizationId?: string; idempotencyKey?: string; endpointMetadata?: TregEndpointHit }): Promise<{ result: unknown; receipt: TregCallReceipt }> {
    const target = options.endpointId.trim();
    if (!target || target.length > 500 || /[#?]/.test(target)) throw new Error("Invalid Treg endpoint or team-tool target");
    if (options.routeVerify && !["treg.people.email.find", "treg.people.phone.find"].includes(target)) {
      throw new Error("Treg route verification is only supported for treg.people.email.find and treg.people.phone.find");
    }
    const isOwnTarget = /^https:\/\//i.test(target) || target.includes("/");
    if (options.endpointMetadata && (isOwnTarget || options.endpointMetadata.id !== target)) throw new Error("Pre-inspected Treg endpoint metadata does not match the requested catalog endpoint");
    const metadata = isOwnTarget ? undefined : options.endpointMetadata ?? await this.getEndpoint(target, options.organizationId);
    const method = (options.method ?? "POST").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error("Unsupported Treg call method; no provider call was made.");
    }
    if (!isOwnTarget) {
      if (!metadata || metadata.id !== target) throw new Error("Treg catalog endpoint metadata could not be verified; inspect the endpoint and retry.");
      if (!metadata.method) throw new Error("Treg catalog endpoint method is unknown; no provider call was made.");
      if (metadata.method !== method) throw new Error(`Treg catalog endpoint requires ${metadata.method}; requested ${method}. No provider call was made.`);
    }
    if (metadata?.strictQuery && options.body !== undefined) throw new Error("strict-query catalog endpoint requires declared query parameters; omit the request body");
    if (isOwnTarget) {
      const tools = await this.myTools(options.organizationId);
      const targetUrl = /^https:\/\//i.test(target) ? new URL(target) : undefined;
      if (targetUrl && (targetUrl.username || targetUrl.password || targetUrl.hash)) throw new Error("Treg team-tool URL must not contain credentials or a fragment");
      const targetName = target.split("/", 1)[0];
      const matches = tools.some((tool) => {
        if (targetUrl) {
          const baseUrl = tool.baseUrl && /^https:\/\//i.test(tool.baseUrl) ? new URL(tool.baseUrl) : undefined;
          return tool.host === targetUrl.host || baseUrl?.host === targetUrl.host;
        }
        return tool.name === targetName;
      });
      if (!matches) throw new Error("Treg team tool is not registered for this organization; inspect CHUCK_TREG_MY_TOOLS first");
    }
    const isRoutedEndpoint = /^treg\./i.test(target);
    const routeMaxCostUsd = isRoutedEndpoint ? options.routeMaxCostUsd ?? config.tregPerCallSoftCapUsd : undefined;
    const hasUnknownPricing = metadata?.priceType === "unknown";
    const estimate = isOwnTarget ? 0 : metadata?.priceVaries || hasUnknownPricing
      ? options.estimateUsd ?? (isRoutedEndpoint ? routeMaxCostUsd ?? config.tregPerCallSoftCapUsd : undefined)
      : metadata?.priceUsd !== undefined
        ? Math.max(metadata.priceUsd, options.estimateUsd ?? 0)
        : options.estimateUsd ?? (isRoutedEndpoint ? routeMaxCostUsd ?? config.tregPerCallSoftCapUsd : undefined);
    if (estimate === undefined) throw new Error("Treg endpoint price is unavailable; inspect the endpoint or provide an owner-approved estimate");
    const reservation = await this.deps.spend.reserve(options.userId, Math.max(estimate, routeMaxCostUsd ?? 0), options.missionId);
    const idempotencyKey = options.idempotencyKey?.trim() || randomUUID();
    if (idempotencyKey.length > 200) throw new Error("Treg idempotency key is too long");
    const callPath = `/call/${encodeURI(target.replace(/^\/+/, ""))}`;
    const started = Date.now();
    let response: { data: unknown; status: number; durationMs: number };
    try {
      response = await this.request<unknown>(method, callPath, options.body, options.query, idempotencyKey, options.organizationId, { ...(routeMaxCostUsd === undefined ? {} : { maxCostUsd: routeMaxCostUsd }), ...(options.routeVerify ? { verify: true } : {}) });
    } catch (error) {
      const providerError = boundedError(error instanceof Error ? error.message : error);
      let settlementError: string | undefined;
      try { await this.deps.spend.settle(reservation, 0); } catch (settlement) { settlementError = boundedError(settlement instanceof Error ? settlement.message : settlement); }
      const receipt: TregCallReceipt = { callId: `treg_err_${randomUUID()}`, endpointId: target, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: 0, ok: false, durationMs: Date.now() - started, at: Date.now(), idempotencyKey, error: boundedError(settlementError ? `${providerError}; spend settlement failed: ${settlementError}` : providerError) };
      await this.deps.recordReceipt(receipt);
      throw new Error(`${providerError}; if you retry this exact request, reuse idempotencyKey ${idempotencyKey}`);
    }

    const row = isObject(response.data) ? response.data : {};
    const responseMeta = (response as { meta?: { callId?: string; costUsd?: number; replayed?: boolean; servedVia?: string; servedBy?: string; ignoredFilters?: string[]; upstreamFailed?: string } }).meta ?? {};
    const route = routeMetadata(response.data);
    const routeRow = isObject(row._treg) ? row._treg : {};
    const upstreamFailed = responseMeta.upstreamFailed ?? (typeof routeRow.upstream_failed === "string" ? routeRow.upstream_failed.slice(0, 240) : routeRow.upstream_failed === true ? "Provider reported an upstream failure" : undefined);
    const reservedMicro = numberOrUndefined(routeRow.reserved_micro);
    const chargedMicro = numberOrUndefined(routeRow.charged_micro);
    const reportedCost = responseMeta.costUsd ?? numberOrUndefined(row.cost_usd ?? row.cost) ?? (chargedMicro === undefined ? undefined : chargedMicro / 1_000_000);
    // Async routed jobs have no confirmed charge yet. Book the route's reserve
    // (or our request reservation) conservatively so retries cannot bypass the
    // local daily/mission budgets, and label it as provisional in the receipt.
    const cost = route.pending
      ? Math.max(reservedMicro === undefined ? 0 : reservedMicro / 1_000_000, reservation.estimateUsd)
      : reportedCost ?? estimate;
    try {
      await this.deps.spend.settle(reservation, cost);
    } catch (error) {
      const receipt: TregCallReceipt = { callId: String(responseMeta.callId ?? row.call_id ?? row.id ?? `treg_settlement_error_${randomUUID()}`), endpointId: target, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: cost, ok: false, statusCode: response.status, durationMs: response.durationMs, at: Date.now(), idempotencyKey, ...(responseMeta.replayed ? { replayed: true } : {}), ...(responseMeta.servedVia ? { servedVia: responseMeta.servedVia } : {}), error: boundedError(`Provider returned data, but Treg spend settlement failed: ${error instanceof Error ? error.message : error}`) };
      await this.deps.recordReceipt(receipt);
      throw new Error(receipt.error);
    }

    const ignoredFilters = route.ignoredFilters?.length ? route.ignoredFilters : responseMeta.ignoredFilters;
    const receipt: TregCallReceipt = { callId: String(responseMeta.callId ?? row.call_id ?? routeRow.call_id ?? row.id ?? `treg_${randomUUID()}`), endpointId: target, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: cost, ok: !upstreamFailed, ...(upstreamFailed ? { upstreamFailed, error: `Treg provider reported an upstream failure: ${upstreamFailed}` } : {}), ...(route.pending ? { pending: true } : {}), ...(route.pending || reportedCost === undefined ? { costIsEstimate: true } : {}), ...(ignoredFilters?.length ? { ignoredFilters } : {}), statusCode: response.status, durationMs: response.durationMs, at: Date.now(), idempotencyKey, ...(responseMeta.replayed ? { replayed: true } : {}), ...(responseMeta.servedVia ? { servedVia: responseMeta.servedVia } : {}), ...(route.servedBy || responseMeta.servedBy ? { servedBy: route.servedBy ?? responseMeta.servedBy } : {}), ...(route.tried?.length ? { routeTried: route.tried } : {}) };
    if (!upstreamFailed && options.missionId && this.deps.recordMissionEvidence) {
      try {
        receipt.missionEvidenceRecorded = await this.deps.recordMissionEvidence({ userId: options.userId, missionId: options.missionId, receipt, resultHash: safeResultHash(row.result ?? response.data) });
      } catch { receipt.missionEvidenceRecorded = false; }
    }
    await this.deps.recordReceipt(receipt);
    if (upstreamFailed) throw new Error(`${receipt.error}; callId ${receipt.callId}; charged $${cost.toFixed(6)}.`);
    return { result: sanitizeProviderResult(row.result ?? response.data), receipt };
  }

  async enrichPerson(options: { userId: number; name?: string; domain?: string; company?: string; linkedinUrl?: string; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<TregEvidenceBundle> {
    const query = ["find work email and profile", options.name, options.domain, options.company, options.linkedinUrl].filter(Boolean).join(" ");
    const routeCap = options.maxSpendUsd ?? config.tregPerCallSoftCapUsd;
    const routedHit = await this.getEndpoint("treg.people.enrich", options.organizationId).catch(() => undefined);
    if (routedHit?.id === "treg.people.enrich") {
      const response = await this.call({ userId: options.userId, endpointId: routedHit.id, body: { full_name: options.name, domain: options.domain, company: options.company, linkedin_url: options.linkedinUrl }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: routeCap, routeMaxCostUsd: routeCap });
      const items = normalizePersonPayload(response.result, routedHit);
      const pending = response.receipt.pending === true;
      return { query, intent: "enrich_person", items, endpointsUsed: [routedHit.id], callId: response.receipt.callId, totalCostUsd: response.receipt.costUsd, warnings: [
        ...(pending ? ["Treg is still processing this enrichment. Do not retry; inspect the existing Treg call first."] : []),
        ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []),
        ...(items.some((item) => item.field === "email") && !items.some((item) => item.field === "email_verified" && item.value === true) ? ["An email was returned without explicit verified status; verify it before outreach."] : []),
        ...(!items.length && !pending ? ["Provider returned no usable fields"] : []),
      ], incomplete: pending || items.length < 2, generatedAt: new Date().toISOString() };
    }
    const initialHits = await this.search(query, 6, options.organizationId);
    const personHits = initialHits.filter((item) => item.category === "enrichment_person" || /email|person|people|enrich/i.test(`${item.id} ${item.title}`));
    const fallbackHits = personHits.length > 0 ? [] : await this.search("work email person enrichment", 15, options.organizationId);
    const personFields = [options.name ? "full_name" : "", options.domain ? "domain" : "", options.company ? "company" : "", options.linkedinUrl ? "linkedin_url" : ""].filter(Boolean);
    const hit = (await this.rank([...initialHits, ...fallbackHits], "enrich_person", query, options.maxSpendUsd, ["full_name", "domain", "company", "linkedin_url"], ["email", "title", "company", "linkedin_url"].filter((field) => !personFields.includes(field))))
      .find((item) => !item.requiresOwnAccount && !item.requiresByok && !/bulk|status|job/i.test(`${item.id} ${item.title}`) && (item.category === "enrichment_person" || /email|person|people|enrich/i.test(`${item.id} ${item.title}`)));
    if (!hit) return emptyBundle(query, "enrich_person", ["No catalog endpoint matched"]);
    const estimateUsd = hit.priceUsd === undefined
      ? options.maxSpendUsd
      : Math.min(hit.priceUsd, options.maxSpendUsd ?? hit.priceUsd);
    const response = await this.call({ userId: options.userId, endpointId: hit.id, body: { full_name: options.name, domain: options.domain, company: options.company, linkedin_url: options.linkedinUrl }, missionId: options.missionId, organizationId: options.organizationId, ...(estimateUsd === undefined ? {} : { estimateUsd }) });
    const items = normalizePersonPayload(response.result, hit);
    return { query, intent: "enrich_person", items, endpointsUsed: [hit.id], callId: response.receipt.callId, totalCostUsd: response.receipt.costUsd, warnings: items.length ? [] : ["Provider returned no usable fields"], incomplete: items.length < 2, generatedAt: new Date().toISOString() };
  }

  async enrichCompany(options: { userId: number; domain?: string; name?: string; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<TregEvidenceBundle> {
    const query = ["company enrichment", options.domain, options.name].filter(Boolean).join(" ");
    const routeCap = options.maxSpendUsd ?? config.tregPerCallSoftCapUsd;
    const routedHit = await this.getEndpoint("treg.companies.enrich", options.organizationId).catch(() => undefined);
    if (routedHit?.id === "treg.companies.enrich") {
      const response = await this.call({ userId: options.userId, endpointId: routedHit.id, body: { domain: options.domain, name: options.name }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: routeCap, routeMaxCostUsd: routeCap });
      const items = normalizeCompanyPayload(response.result, routedHit);
      const pending = response.receipt.pending === true;
      return { query, intent: "enrich_company", items, endpointsUsed: [routedHit.id], callId: response.receipt.callId, totalCostUsd: response.receipt.costUsd, warnings: [...(pending ? ["Treg is still processing this enrichment. Do not retry; inspect the existing Treg call first."] : []), ...(response.receipt.costIsEstimate ? ["No confirmed charge was included; displayed cost is the locally reserved estimate."] : []), ...(!items.length && !pending ? ["Provider returned no usable fields"] : [])], incomplete: pending || items.length === 0, generatedAt: new Date().toISOString() };
    }
    const initialHits = await this.search(query, 8, options.organizationId);
    const initialCompanyHits = initialHits.filter((item) => item.category === "enrichment_company" || /company|companies|firmographic|domain/i.test(`${item.id} ${item.title}`));
    const fallbackHits = initialCompanyHits.length > 0 ? [] : await this.search("company enrichment by domain", 10, options.organizationId);
    const hit = (await this.rank([...initialHits, ...fallbackHits], "enrich_company", query, options.maxSpendUsd, ["domain", "company", "name"], ["company_name", "domain", "industry", "employee_count", "description"]))
      .find((item) => !item.requiresOwnAccount && !item.requiresByok && (item.category === "enrichment_company" || /company|companies|firmographic|domain/i.test(`${item.id} ${item.title}`)));
    if (!hit) return emptyBundle(query, "enrich_company", ["No catalog endpoint matched"]);
    const estimateUsd = hit.priceUsd === undefined ? options.maxSpendUsd : Math.min(hit.priceUsd, options.maxSpendUsd ?? hit.priceUsd);
    const response = await this.call({ userId: options.userId, endpointId: hit.id, body: { domain: options.domain, name: options.name }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd });
    return { query, intent: "enrich_company", items: normalizeCompanyPayload(response.result, hit), endpointsUsed: [hit.id], callId: response.receipt.callId, totalCostUsd: response.receipt.costUsd, warnings: [], incomplete: false, generatedAt: new Date().toISOString() };
  }

  async resolveDataNeed(options: { userId: number; need: string; missionId?: string; maxCalls?: number; maxSpendUsd?: number; requiredFields?: string[]; organizationId?: string; readOnlyOnly?: boolean }): Promise<TregEvidenceBundle> {
    const maxCalls = Math.min(options.maxCalls ?? 3, 5);
    const maxSpend = options.maxSpendUsd ?? config.tregMissionBudgetUsd;
    let spent = 0;
    const items: TregEvidenceItem[] = [];
    const used: string[] = [];
    const warnings: string[] = [];
    const ranked = await this.rank(await this.search(options.need, 10, options.organizationId), options.need, options.need, maxSpend, undefined, options.requiredFields);
    const eligible: TregEndpointHit[] = [];
    for (const hit of ranked) {
      if (!options.readOnlyOnly) {
        eligible.push(hit);
        continue;
      }
      let inspected: TregEndpointHit;
      try { inspected = await this.getEndpoint(hit.id, options.organizationId); }
      catch (error) {
        warnings.push(`Skipped ${hit.id}: endpoint method could not be inspected (${boundedError(error instanceof Error ? error.message : error)})`);
        continue;
      }
      if (!inspected.method || !["GET", "HEAD", "OPTIONS"].includes(inspected.method)) {
        warnings.push(`Skipped ${hit.id}: endpoint is not explicitly declared read-only`);
        continue;
      }
      if (inspected.id !== hit.id || inspected.priceUnit !== "call" || inspected.priceUsd === undefined || inspected.priceVaries || inspected.priceType === "per_result" || inspected.priceType === "unknown") {
        warnings.push(`Skipped ${hit.id}: exact endpoint identity or per-call pricing could not be verified`);
        continue;
      }
      if (inspected.priceUsd > maxSpend) {
        warnings.push(`Skipped ${hit.id}: declared per-call price exceeds the available spend limit`);
        continue;
      }
      eligible.push(inspected);
    }
    for (const hit of eligible.slice(0, maxCalls)) {
      if (spent >= maxSpend) { warnings.push("Stopped: mission spend cap"); break; }
      if (hit.requiresOwnAccount || hit.requiresByok) { warnings.push(`Skipped ${hit.id}: requires an owner account or BYOK`); continue; }
      try {
        const response = await this.call({
          userId: options.userId,
          endpointId: hit.id,
          method: options.readOnlyOnly ? hit.method : undefined,
          ...(options.readOnlyOnly ? { query: { q: options.need } } : { body: { q: options.need } }),
          missionId: options.missionId,
          organizationId: options.organizationId,
          estimateUsd: hit.priceUsd,
        });
        spent += response.receipt.costUsd;
        used.push(hit.id);
        items.push(...coerceEvidence(response.result, hit));
        if (options.requiredFields?.length && options.requiredFields.every((field) => items.some((item) => item.field === field))) break;
      } catch (error) { warnings.push(`${hit.id}: ${boundedError(error instanceof Error ? error.message : error)}`); }
    }
    return { query: options.need, intent: "resolve_data_need", items: dedupeEvidence(items), endpointsUsed: used, totalCostUsd: spent, warnings, incomplete: Boolean((options.readOnlyOnly && used.length === 0) || options.requiredFields?.some((field) => !items.some((item) => item.field === field))), generatedAt: new Date().toISOString() };
  }
}
