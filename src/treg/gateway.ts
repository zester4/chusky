import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { TregCallReceipt, TregCategory, TregEndpointHit, TregEvidenceBundle, TregEvidenceItem, TregOAuthConnection } from "./types.js";
import type { TregSpendGuard } from "./spend.js";

export interface TregGatewayDeps {
  spend: TregSpendGuard;
  recordReceipt: (receipt: TregCallReceipt) => Promise<void>;
  recordMissionEvidence?: (input: { userId: number; missionId: string; receipt: TregCallReceipt; resultHash: string }) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => Boolean(value && typeof value === "object" && !Array.isArray(value));

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boundedError(value: unknown): string {
  return String(value ?? "Unknown Treg error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return isObject(error) && error.name === "AbortError";
}

function normalizeHit(raw: unknown): TregEndpointHit {
  const row = isObject(raw) ? raw : {};
  const id = String(row.id ?? row.endpoint_id ?? row.slug ?? "").trim();
  if (!id) throw new Error("Treg returned an endpoint without an id");
  return {
    id,
    title: String(row.title ?? row.name ?? id).slice(0, 240),
    provider: String(row.provider ?? row.platform ?? "unknown").slice(0, 120),
    category: mapCategory(row),
    priceUsd: numberOrUndefined(row.price_usd ?? row.price ?? row.unit_price),
    priceUnit: row.price_unit === "call" || row.price_unit === "result" || row.price_unit === "row" ? row.price_unit : "unknown",
    successRate: numberOrUndefined(row.success_rate),
    latencyMs: numberOrUndefined(row.latency_ms ?? row.median_ms),
    requiresOwnAccount: Boolean(row.requires_own_account ?? row.oauth),
    requiresByok: Boolean(row.requires_byok ?? row.byok_only),
  };
}

function mapCategory(raw: JsonObject): TregCategory {
  const value = `${String(raw.category ?? "")} ${String(raw.title ?? "")} ${String(raw.id ?? "")}`.toLowerCase();
  if (/email|person|people|hunter|apollo/.test(value)) return "enrichment_person";
  if (/company|firm|crunchbase|domain/.test(value)) return "enrichment_company";
  if (/backlink|keyword|seo|semrush|moz/.test(value)) return "seo";
  if (/tiktok|instagram|twitter|social/.test(value)) return "social_intel";
  if (/ads? library|facebook ads|google ads/.test(value)) return "ads_intel";
  if (/scrape|serp|web/.test(value)) return "web_data";
  return "other";
}

function payloadRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return [];
  for (const key of ["results", "endpoints", "data"]) if (Array.isArray(data[key])) return data[key] as unknown[];
  return [];
}

function evidenceValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return (JSON.stringify(value) ?? String(value)).slice(0, 2000);
}

function evidence(field: string, value: unknown, hit: TregEndpointHit, confidence = 0.7): TregEvidenceItem | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return { field, value: evidenceValue(value), confidence: Math.max(0, Math.min(1, confidence)), sourceEndpoint: hit.id, sourceProvider: hit.provider, observedAt: new Date().toISOString() };
}

function normalizePersonPayload(result: unknown, hit: TregEndpointHit): TregEvidenceItem[] {
  const row = isObject(result) ? result : {};
  const items = [
    evidence("email", row.email ?? row.work_email ?? row.value, hit),
    evidence("full_name", row.name ?? row.full_name, hit),
    evidence("title", row.title ?? row.job_title, hit),
    evidence("linkedin_url", row.linkedin ?? row.linkedin_url, hit),
    evidence("company", row.company ?? row.organization, hit),
    evidence("domain", row.domain, hit),
  ].filter((item): item is TregEvidenceItem => Boolean(item));
  if (!items.length && result !== null && typeof result === "object") {
    const raw = evidence("raw", result, hit, 0.3);
    if (raw) items.push(raw);
  }
  return items;
}

function normalizeCompanyPayload(result: unknown, hit: TregEndpointHit): TregEvidenceItem[] {
  const row = isObject(result) ? result : {};
  return [
    evidence("company_name", row.name ?? row.company, hit),
    evidence("domain", row.domain ?? row.website, hit),
    evidence("industry", row.industry, hit),
    evidence("employee_count", row.employees ?? row.employee_count, hit),
    evidence("description", row.description, hit),
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

function rankHits(hits: TregEndpointHit[], intent: string, maxSpendUsd?: number): TregEndpointHit[] {
  const query = intent.toLowerCase();
  return [...hits].sort((a, b) => {
    const score = (hit: TregEndpointHit): number => {
      const categoryBoost = query.includes("person") && hit.category === "enrichment_person" || query.includes("company") && hit.category === "enrichment_company" || query.includes("seo") && hit.category === "seo" || query.includes("social") && hit.category === "social_intel" || query.includes("ads") && hit.category === "ads_intel" || query.includes("web") && hit.category === "web_data" ? 50 : 0;
      const affordable = hit.priceUsd === undefined || maxSpendUsd === undefined || hit.priceUsd <= maxSpendUsd ? 20 : -100;
      const reliability = hit.successRate === undefined ? 0 : Math.max(0, Math.min(1, hit.successRate)) * 20;
      const latency = hit.latencyMs === undefined ? 0 : Math.max(-10, 10 - hit.latencyMs / 1000);
      const price = hit.priceUsd === undefined ? -5 : Math.max(-10, 5 - hit.priceUsd * 10);
      return categoryBoost + affordable + reliability + latency + price + (hit.requiresOwnAccount || hit.requiresByok ? -40 : 0);
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

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>, idempotencyKey?: string, organizationId?: string): Promise<{ data: T; status: number; durationMs: number }> {
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
          headers: { accept: "application/json", "content-type": "application/json", "X-Treg-Token": credential.token, ...(credential.tregOrgId ? { "x-treg-org": credential.tregOrgId } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const durationMs = Date.now() - started;
        const text = await response.text();
        let data: unknown = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
        const transient = [408, 425, 429].includes(response.status) || response.status >= 500;
        if (retryableMethod && transient) {
          if (attempt < config.tregMaxRetries) {
            lastError = new Error(`Treg upstream ${response.status}`);
            await this.sleep(Math.min(1000, 100 * 2 ** attempt));
            continue;
          }
        }
        if (!response.ok) {
          const detail = isObject(data) ? data.detail ?? data.message : text;
          throw new Error(`Treg ${upper} ${path} failed (${response.status}): ${boundedError(detail)}`);
        }
        return { data: data as T, status: response.status, durationMs };
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

  async call(options: { userId: number; endpointId: string; method?: string; body?: unknown; query?: Record<string, string | number | undefined>; missionId?: string; estimateUsd?: number; organizationId?: string }): Promise<{ result: unknown; receipt: TregCallReceipt }> {
    const metadata = await this.getEndpoint(options.endpointId, options.organizationId).catch(() => undefined);
    const estimate = options.estimateUsd ?? metadata?.priceUsd;
    if (estimate === undefined) throw new Error("Treg endpoint price is unavailable; inspect the endpoint or provide an owner-approved estimate");
    const reservation = await this.deps.spend.reserve(options.userId, estimate, options.missionId);
    const method = (options.method ?? "POST").toUpperCase();
    const idempotencyKey = randomUUID();
    const started = Date.now();
    let response: { data: unknown; status: number; durationMs: number };
    try {
      response = await this.request<unknown>(method, `/call/${options.endpointId.replace(/^\//, "")}`, options.body, options.query, idempotencyKey, options.organizationId);
    } catch (error) {
      const providerError = boundedError(error instanceof Error ? error.message : error);
      let settlementError: string | undefined;
      try { await this.deps.spend.settle(reservation, 0); } catch (settlement) { settlementError = boundedError(settlement instanceof Error ? settlement.message : settlement); }
      const receipt: TregCallReceipt = { callId: `treg_err_${randomUUID()}`, endpointId: options.endpointId, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: 0, ok: false, durationMs: Date.now() - started, at: Date.now(), error: boundedError(settlementError ? `${providerError}; spend settlement failed: ${settlementError}` : providerError) };
      await this.deps.recordReceipt(receipt);
      throw error;
    }

    const row = isObject(response.data) ? response.data : {};
    const cost = numberOrUndefined(row.cost_usd ?? row.cost) ?? estimate;
    try {
      await this.deps.spend.settle(reservation, cost);
    } catch (error) {
      const receipt: TregCallReceipt = { callId: String(row.call_id ?? row.id ?? `treg_settlement_error_${randomUUID()}`), endpointId: options.endpointId, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: cost, ok: false, statusCode: response.status, durationMs: response.durationMs, at: Date.now(), error: boundedError(`Provider returned data, but Treg spend settlement failed: ${error instanceof Error ? error.message : error}`) };
      await this.deps.recordReceipt(receipt);
      throw new Error(receipt.error);
    }

    const receipt: TregCallReceipt = { callId: String(row.call_id ?? row.id ?? `treg_${randomUUID()}`), endpointId: options.endpointId, userId: options.userId, missionId: options.missionId, ...(options.organizationId ? { organizationId: options.organizationId } : {}), costUsd: cost, ok: true, statusCode: response.status, durationMs: response.durationMs, at: Date.now() };
    if (options.missionId && this.deps.recordMissionEvidence) {
      try {
        receipt.missionEvidenceRecorded = await this.deps.recordMissionEvidence({ userId: options.userId, missionId: options.missionId, receipt, resultHash: safeResultHash(row.result ?? response.data) });
      } catch { receipt.missionEvidenceRecorded = false; }
    }
    await this.deps.recordReceipt(receipt);
    return { result: row.result ?? response.data, receipt };
  }

  async enrichPerson(options: { userId: number; name?: string; domain?: string; company?: string; linkedinUrl?: string; missionId?: string; maxSpendUsd?: number; organizationId?: string }): Promise<TregEvidenceBundle> {
    const query = ["find work email and profile", options.name, options.domain, options.company, options.linkedinUrl].filter(Boolean).join(" ");
    const hit = rankHits(await this.search(query, 6, options.organizationId), "enrich_person", options.maxSpendUsd).find((item) => !item.requiresOwnAccount && !item.requiresByok);
    if (!hit) return emptyBundle(query, "enrich_person", ["No catalog endpoint matched"]);
    const estimateUsd = hit.priceUsd === undefined
      ? options.maxSpendUsd
      : Math.min(hit.priceUsd, options.maxSpendUsd ?? hit.priceUsd);
    const response = await this.call({ userId: options.userId, endpointId: hit.id, body: { full_name: options.name, domain: options.domain, company: options.company, linkedin_url: options.linkedinUrl }, missionId: options.missionId, organizationId: options.organizationId, ...(estimateUsd === undefined ? {} : { estimateUsd }) });
    const items = normalizePersonPayload(response.result, hit);
    return { query, intent: "enrich_person", items, endpointsUsed: [hit.id], totalCostUsd: response.receipt.costUsd, warnings: items.length ? [] : ["Provider returned no usable fields"], incomplete: items.length < 2, generatedAt: new Date().toISOString() };
  }

  async enrichCompany(options: { userId: number; domain?: string; name?: string; missionId?: string; organizationId?: string }): Promise<TregEvidenceBundle> {
    const query = ["company enrichment", options.domain, options.name].filter(Boolean).join(" ");
    const hit = rankHits(await this.search(query, 6, options.organizationId), "enrich_company").find((item) => !item.requiresOwnAccount && !item.requiresByok);
    if (!hit) return emptyBundle(query, "enrich_company", ["No catalog endpoint matched"]);
    const response = await this.call({ userId: options.userId, endpointId: hit.id, body: { domain: options.domain, company: options.name }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: hit.priceUsd });
    return { query, intent: "enrich_company", items: normalizeCompanyPayload(response.result, hit), endpointsUsed: [hit.id], totalCostUsd: response.receipt.costUsd, warnings: [], incomplete: false, generatedAt: new Date().toISOString() };
  }

  async resolveDataNeed(options: { userId: number; need: string; missionId?: string; maxCalls?: number; maxSpendUsd?: number; requiredFields?: string[]; organizationId?: string }): Promise<TregEvidenceBundle> {
    const maxCalls = Math.min(options.maxCalls ?? 3, 5);
    const maxSpend = options.maxSpendUsd ?? config.tregMissionBudgetUsd;
    let spent = 0;
    const items: TregEvidenceItem[] = [];
    const used: string[] = [];
    const warnings: string[] = [];
    for (const hit of rankHits(await this.search(options.need, 10, options.organizationId), options.need, maxSpend).slice(0, maxCalls)) {
      if (spent >= maxSpend) { warnings.push("Stopped: mission spend cap"); break; }
      if (hit.requiresOwnAccount || hit.requiresByok) { warnings.push(`Skipped ${hit.id}: requires an owner account or BYOK`); continue; }
      try {
        const response = await this.call({ userId: options.userId, endpointId: hit.id, body: { q: options.need }, missionId: options.missionId, organizationId: options.organizationId, estimateUsd: hit.priceUsd });
        spent += response.receipt.costUsd;
        used.push(hit.id);
        items.push(...coerceEvidence(response.result, hit));
        if (options.requiredFields?.length && options.requiredFields.every((field) => items.some((item) => item.field === field))) break;
      } catch (error) { warnings.push(`${hit.id}: ${boundedError(error instanceof Error ? error.message : error)}`); }
    }
    return { query: options.need, intent: "resolve_data_need", items: dedupeEvidence(items), endpointsUsed: used, totalCostUsd: spent, warnings, incomplete: Boolean(options.requiredFields?.some((field) => !items.some((item) => item.field === field))), generatedAt: new Date().toISOString() };
  }
}
