import { isIP } from "node:net";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai/";
const AGENT_URL = "https://agent.tinyfish.ai";
const MONITOR_URL = "https://agent.tinyfish.chat";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_FETCH_TEXT_CHARS = 20_000;
const MAX_PAGE_TEXT_CHARS = 8_000;

type SearchInput = {
  query: string;
  location?: string;
  language?: string;
  recencyMinutes?: number;
  afterDate?: string;
  beforeDate?: string;
  page?: number;
  purpose?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  domainType?: "web" | "news" | "research_paper";
  pubYearMin?: number;
  pubYearMax?: number;
};

type FetchInput = {
  urls: string[];
  format?: "markdown" | "html" | "json";
  links?: boolean;
  imageLinks?: boolean;
  ttl?: number;
  perUrlTimeoutMs?: number;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  includeEtagAndLastModified?: boolean;
  includeSelectors?: string[];
  excludeSelectors?: string[];
  highlights?: { query: string; maxCount?: number; maxCharacters?: number };
  purpose?: string;
};

type TinyFishMonitorInput = {
  type: "fetch" | "search";
  name: string;
  config: Record<string, unknown>;
  schedule_cron: string;
  purpose?: string;
  webhook_url: string;
};

function sseJsonEvents(response: Response, signal: AbortSignal | undefined, onEvent: (event: Record<string, unknown>) => Promise<void | boolean>) {
  return (async () => {
    if (!response.body) throw new Error("TinyFish Research returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let done = false;
    let endedByProvider = false;
    const dispatch = async (frame: string) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new Error("TinyFish Research returned an invalid event."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("TinyFish Research returned an invalid event.");
      const event = parsed as Record<string, unknown>;
      const stop = await onEvent(event);
      if (event.event === "done") { done = true; endedByProvider = true; }
      else if (stop === true) done = true;
    };
    try {
      while (!done) {
        if (signal?.aborted) throw signal.reason ?? new Error("TinyFish Research was cancelled.");
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8_000_000) throw new Error("TinyFish Research exceeded the 8 MB safety limit.");
        buffer += decoder.decode(next.value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          await dispatch(frame);
          if (/^event:\s*done\s*$/m.test(frame)) { done = true; break; }
        }
      }
      buffer += decoder.decode();
      if (!done && buffer.trim()) await dispatch(buffer);
    } finally {
      if (!endedByProvider) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return assertPublicHttpUrl(value).slice(0, 2_000); } catch { return undefined; }
}

function boundedStructuredValue(value: unknown, maxChars: number): { value: unknown; size: number; truncated: boolean } {
  if (typeof value === "string") return { value: value.slice(0, maxChars), size: Math.min(value.length, maxChars), truncated: value.length > maxChars };
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { value: null, size: 0, truncated: true }; }
  if (serialized.length <= maxChars) return { value, size: serialized.length, truncated: false };
  return { value: { truncated: true, preview: serialized.slice(0, maxChars) }, size: maxChars, truncated: true };
}

function boundedLinks(value: unknown, max: number): Array<string | { url?: string; title?: string }> {
  if (!Array.isArray(value)) return [];
  const links: Array<string | { url?: string; title?: string }> = [];
  for (const item of value.slice(0, max)) {
    if (typeof item === "string") {
      links.push(item.slice(0, 2_000));
      continue;
    }
    const link = record(item);
    const url = safePublicUrl(link.url ?? link.href);
    const title = boundedString(link.title ?? link.text, 300);
    if (url || title) links.push({ ...(url ? { url } : {}), ...(title ? { title } : {}) });
  }
  return links;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function optionalSearchText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) throw new Error(`TinyFish ${field} must be at most ${max} characters when provided.`);
  return normalized;
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain || domain.length > 253 || domain.includes("/") || domain.includes(":") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("TinyFish domain filters must contain plain public hostnames.");
  }
  return domain;
}

export function assertPublicHttpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Each TinyFish URL must be a valid public http(s) URL."); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || !host || isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) {
    throw new Error("Each TinyFish URL must be a public http(s) hostname without credentials or a local address.");
  }
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("TinyFish response exceeded the 2 MB safety limit.");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("TinyFish response exceeded the 2 MB safety limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error("TinyFish returned an invalid JSON response."); }
}

export function createTinyFishClient(apiKey: string, fetcher: typeof fetch = fetch) {
  if (!apiKey.trim()) throw new Error("TinyFish is not configured. Set the server-only TINYFISH_API_KEY.");

  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signals = init.signal ? [init.signal, timeoutSignal] : [timeoutSignal];
    const response = await fetcher(url, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
    const payload = await readBoundedJson(response);
    if (!response.ok) throw new Error(`TinyFish request failed with HTTP ${response.status}.`);
    return payload;
  }

  return {
    async search(input: SearchInput, signal?: AbortSignal) {
      const query = input.query.trim();
      if (query.length < 2 || query.length > 500) throw new Error("TinyFish search query must contain 2 to 500 characters.");
      const location = optionalSearchText(input.location, "location", 100);
      const language = optionalSearchText(input.language, "language", 20);
      const purpose = optionalSearchText(input.purpose, "purpose", 2_000);
      const afterDate = optionalSearchText(input.afterDate, "afterDate", 10);
      const beforeDate = optionalSearchText(input.beforeDate, "beforeDate", 10);
      if (input.domainType !== undefined && !["web", "news", "research_paper"].includes(input.domainType)) throw new Error("TinyFish domainType is unsupported.");
      if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 0 || input.page > 10)) throw new Error("TinyFish page must be an integer from 0 to 10.");
      if (input.recencyMinutes !== undefined && (!Number.isInteger(input.recencyMinutes) || input.recencyMinutes < 1 || input.recencyMinutes > 5_256_000)) throw new Error("recencyMinutes must be an integer from 1 to 5256000.");
      if ([input.pubYearMin, input.pubYearMax].some((year) => year !== undefined && (!Number.isInteger(year) || year < 0 || year > 9999))) throw new Error("Publication years must be integers from 0 to 9999.");
      if ((input.includeDomains?.length ?? 0) > 20 || (input.excludeDomains?.length ?? 0) > 20) throw new Error("TinyFish search accepts at most 20 domains per filter.");
      if (input.recencyMinutes !== undefined && (afterDate || beforeDate)) throw new Error("Use recencyMinutes or a date range, not both.");
      if (afterDate && !validCalendarDate(afterDate)) throw new Error("afterDate must be a valid YYYY-MM-DD calendar date.");
      if (beforeDate && !validCalendarDate(beforeDate)) throw new Error("beforeDate must be a valid YYYY-MM-DD calendar date.");
      if (afterDate && beforeDate && afterDate > beforeDate) throw new Error("afterDate must be on or before beforeDate.");

      const params = new URLSearchParams({ query });
      if (location) params.set("location", location);
      if (language) params.set("language", language);
      if (input.recencyMinutes !== undefined) params.set("recency_minutes", String(input.recencyMinutes));
      if (afterDate) params.set("after_date", afterDate);
      if (beforeDate) params.set("before_date", beforeDate);
      if (input.page !== undefined) params.set("page", String(input.page));
      if (purpose) params.set("purpose", purpose);
      if (input.includeDomains?.length) params.set("include_domains", input.includeDomains.slice(0, 20).map(validateDomain).join(","));
      if (input.excludeDomains?.length) params.set("exclude_domains", input.excludeDomains.slice(0, 20).map(validateDomain).join(","));
      if (input.domainType) params.set("domain_type", input.domainType);
      if (input.pubYearMin !== undefined) params.set("pub_year_min", String(input.pubYearMin));
      if (input.pubYearMax !== undefined) params.set("pub_year_max", String(input.pubYearMax));
      if ((input.pubYearMin !== undefined || input.pubYearMax !== undefined) && input.domainType !== "research_paper") throw new Error("Publication-year filters require research_paper domainType.");
      if (input.pubYearMin !== undefined && input.pubYearMax !== undefined && input.pubYearMin > input.pubYearMax) throw new Error("pubYearMin must be no greater than pubYearMax.");
      if (input.domainType === "research_paper" && (input.recencyMinutes !== undefined || afterDate || beforeDate)) throw new Error("Research-paper search uses publication-year filters, not date or recency filters.");

      const payload = record(await request(`${SEARCH_URL}?${params}`, {
        method: "GET",
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
        signal,
      }, 30_000));
      const results = Array.isArray(payload.results) ? payload.results.slice(0, MAX_SEARCH_RESULTS).map((item) => {
        const result = record(item);
        return {
          position: typeof result.position === "number" ? result.position : undefined,
          site_name: boundedString(result.site_name, 200),
          title: boundedString(result.title, 500),
          snippet: boundedString(result.snippet, 2_000),
          url: safePublicUrl(result.url),
          publisher: boundedString(result.publisher, 200),
          published_date: boundedString(result.date ?? result.published_date, 100),
          authors: Array.isArray(result.authors) ? result.authors.filter((value): value is string => typeof value === "string").slice(0, 10).map((value) => value.slice(0, 200)) : undefined,
          venue: boundedString(result.venue, 300),
          year: typeof result.year === "number" ? result.year : undefined,
          citation_count: typeof result.cited_by_count === "number" ? result.cited_by_count : undefined,
        };
      }) : [];
      return { query: boundedString(payload.query, 500) ?? query, results, total_results: typeof payload.total_results === "number" ? payload.total_results : undefined, page: typeof payload.page === "number" ? payload.page : input.page ?? 0 };
    },

    async fetch(input: FetchInput, signal?: AbortSignal) {
      if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10) throw new Error("TinyFish fetch accepts 1 to 10 URLs per request.");
      const urls = input.urls.map((value) => assertPublicHttpUrl(value));
      if ((input.includeSelectors?.length ?? 0) > 20 || (input.excludeSelectors?.length ?? 0) > 20) throw new Error("TinyFish Fetch accepts at most 20 selectors per filter.");
      if (input.ifNoneMatch && urls.length !== 1) throw new Error("Conditional fetch accepts exactly one URL.");
      if (input.ifModifiedSince && urls.length !== 1) throw new Error("Conditional fetch accepts exactly one URL.");
      if (input.highlights && input.format && input.format !== "markdown") throw new Error("TinyFish highlights require markdown format.");
      if (input.highlights && (input.highlights.query.trim().length < 1 || input.highlights.query.length > 2_000)) throw new Error("TinyFish highlights query must contain 1 to 2,000 characters.");
      if (input.highlights && ((input.highlights.maxCount !== undefined && (!Number.isInteger(input.highlights.maxCount) || input.highlights.maxCount < 1 || input.highlights.maxCount > 20)) || (input.highlights.maxCharacters !== undefined && (!Number.isInteger(input.highlights.maxCharacters) || input.highlights.maxCharacters < 100 || input.highlights.maxCharacters > 20_000)))) throw new Error("TinyFish highlight limits are outside the supported range.");
      if (input.ttl !== undefined && (!Number.isInteger(input.ttl) || input.ttl < 0)) throw new Error("TinyFish ttl must be a non-negative integer.");
      if (input.perUrlTimeoutMs !== undefined && (!Number.isInteger(input.perUrlTimeoutMs) || input.perUrlTimeoutMs < 1 || input.perUrlTimeoutMs > 110_000)) throw new Error("TinyFish perUrlTimeoutMs must be from 1 to 110000.");
      if ([...(input.includeSelectors ?? []), ...(input.excludeSelectors ?? [])].some((selector) => selector.trim().length < 1 || selector.length > 1_000)) throw new Error("TinyFish selectors must contain 1 to 1000 characters.");
      const payload = record(await request(FETCH_URL, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          urls, format: input.format ?? "markdown", links: input.links ?? false, image_links: input.imageLinks ?? false,
          ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
          ...(input.perUrlTimeoutMs !== undefined ? { per_url_timeout_ms: input.perUrlTimeoutMs } : {}),
          ...(input.ifNoneMatch ? { if_none_match: input.ifNoneMatch } : {}),
          ...(input.ifModifiedSince ? { if_modified_since: input.ifModifiedSince } : {}),
          ...(input.includeEtagAndLastModified ? { include_etag_and_last_modified: true } : {}),
          ...(input.includeSelectors?.length ? { include_selectors: input.includeSelectors.slice(0, 20) } : {}),
          ...(input.excludeSelectors?.length ? { exclude_selectors: input.excludeSelectors.slice(0, 20) } : {}),
          ...(input.purpose ? { purpose: input.purpose.trim().slice(0, 2_000) } : {}),
          ...(input.highlights ? { highlights: { query: input.highlights.query.trim(), ...(input.highlights.maxCount !== undefined ? { max_snippets: input.highlights.maxCount } : {}), ...(input.highlights.maxCharacters !== undefined ? { max_characters: input.highlights.maxCharacters } : {}) } } : {}),
        }),
        signal,
      }, 150_000));

      let remaining = MAX_FETCH_TEXT_CHARS;
      const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, urls.length).map((item) => {
        const result = record(item);
        const boundedText = boundedStructuredValue(result.text ?? "", Math.min(MAX_PAGE_TEXT_CHARS, Math.max(0, remaining)));
        const text = boundedText.value;
        remaining = Math.max(0, remaining - boundedText.size);
        return {
          url: safePublicUrl(result.url),
          final_url: safePublicUrl(result.final_url),
          title: boundedString(result.title, 500),
          description: boundedString(result.description, 1_000),
          language: boundedString(result.language, 40),
          author: boundedString(result.author, 200),
          published_date: boundedString(result.published_date, 80),
          latency_ms: typeof result.latency_ms === "number" ? result.latency_ms : undefined,
          etag: boundedString(result.etag, 500),
          last_modified: boundedString(result.last_modified, 200),
          not_modified: result.not_modified === true,
          format: boundedString(result.format, 20) ?? input.format ?? "markdown",
          text,
          truncated: boundedText.truncated,
          highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 20).map((item) => {
            const highlight = record(item);
            return { text: boundedString(highlight.text ?? highlight.snippet, 1_500), rank: typeof highlight.rank === "number" ? highlight.rank : undefined };
          }) : undefined,
          unmatched_selectors: Array.isArray(result.unmatched_selectors) ? result.unmatched_selectors.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 300)) : undefined,
          ...(input.links ? { links: boundedLinks(result.links, 30) } : {}),
          ...(input.imageLinks ? { image_links: boundedLinks(result.image_links, 20) } : {}),
        };
      });
      const errors = (Array.isArray(payload.errors) ? payload.errors : []).slice(0, urls.length).map((item) => {
        const error = record(item);
        return { url: safePublicUrl(error.url), error: boundedString(error.error, 500), status: typeof error.status === "number" ? error.status : undefined, unmatched_selectors: Array.isArray(error.unmatched_selectors) ? error.unmatched_selectors.filter((entry): entry is string => typeof entry === "string").slice(0, 20).map((entry) => entry.slice(0, 1000)) : undefined, candidate_selectors: Array.isArray(error.candidate_selectors) ? error.candidate_selectors.filter((entry): entry is string => typeof entry === "string").slice(0, 10).map((entry) => entry.slice(0, 1000)) : undefined };
      });
      return { results, errors, contentIsUntrusted: true };
    },

    async research(input: { query: string; mode?: "standard" | "deep"; outputLanguage?: string; domainType?: "web" | "news" | "research_paper"; afterDate?: string; beforeDate?: string; recencyMinutes?: number; includeDomains?: string[]; excludeDomains?: string[]; onRunCreated?: (id: string) => Promise<void>; onProgress?: (event: string) => Promise<void> | void }, signal?: AbortSignal) {
      const query = input.query.trim();
      if (query.length < 1 || query.length > 2_000) throw new Error("TinyFish Research query must contain 1 to 2,000 characters.");
      if (input.recencyMinutes !== undefined && (input.afterDate || input.beforeDate)) throw new Error("Use recencyMinutes or a date range, not both.");
      if (input.domainType === "research_paper" && (input.recencyMinutes !== undefined || input.afterDate || input.beforeDate)) throw new Error("Research-paper queries use publication-year filters, not date or recency filters.");
      if (input.recencyMinutes !== undefined && (!Number.isInteger(input.recencyMinutes) || input.recencyMinutes < 1 || input.recencyMinutes > 5_256_000)) throw new Error("recencyMinutes must be an integer from 1 to 5256000.");
      if (input.afterDate && !validCalendarDate(input.afterDate)) throw new Error("afterDate must be a valid YYYY-MM-DD calendar date.");
      if (input.beforeDate && !validCalendarDate(input.beforeDate)) throw new Error("beforeDate must be a valid YYYY-MM-DD calendar date.");
      if (input.afterDate && input.beforeDate && input.afterDate > input.beforeDate) throw new Error("afterDate must be on or before beforeDate.");
      // Standard/deep Research are search + static Fetch modes. Do not send
      // browser_enabled: TinyFish only accepts that field for Max, which is
      // intentionally excluded from Chusky's integration.
      const payload: Record<string, unknown> = { query, mode: input.mode ?? "standard", stream: false };
      if (input.outputLanguage) payload.output_language = input.outputLanguage.slice(0, 35);
      if (input.domainType) payload.domain_type = input.domainType;
      if (input.afterDate) payload.after_date = input.afterDate;
      if (input.beforeDate) payload.before_date = input.beforeDate;
      if (input.recencyMinutes !== undefined) payload.recency_minutes = input.recencyMinutes;
      if (input.includeDomains?.length) payload.domain_filter = { ...record(payload.domain_filter), include_domains: input.includeDomains.slice(0, 20).map(validateDomain) };
      if (input.excludeDomains?.length) payload.domain_filter = { ...record(payload.domain_filter), exclude_domains: input.excludeDomains.slice(0, 20).map(validateDomain) };
      const response = await fetcher(`${AGENT_URL}/v1/automation/run-research`, {
        method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]) : AbortSignal.timeout(20 * 60_000), redirect: "error",
      });
      if (!response.ok) { await readBoundedJson(response); throw new Error(`TinyFish Research request failed with HTTP ${response.status}.`); }
      let runId: string | undefined;
      let finalResult: Record<string, unknown> | undefined;
      let streamError: string | undefined;
      const reported = new Set<string>();
      await sseJsonEvents(response, signal, async (event) => {
        if (event.event === "created" && typeof event.research_run_id === "string") {
          runId = event.research_run_id.slice(0, 160);
          await input.onRunCreated?.(runId);
        } else if (event.event === "final_result") finalResult = event;
        else if (event.event === "error") streamError = boundedString(record(event.error).message ?? event.message, 500) ?? "TinyFish Research failed.";
        else if (["plan_updated", "sources_searched", "source_fetched", "partial_summary", "heartbeat"].includes(String(event.event))) {
          const stage = String(event.event);
          if (!reported.has(stage)) { reported.add(stage); await input.onProgress?.(stage); }
        }
      });
      if (streamError) throw new Error(streamError);
      if (!runId) throw new Error("TinyFish Research ended before it provided a run ID.");
      if (!finalResult) throw new Error("TinyFish Research ended without a final report; inspect the saved run status before retrying.");
      return { researchRunId: runId, result: boundedString(finalResult.result, 40_000) ?? "", citations: Array.isArray(finalResult.citations) ? finalResult.citations.slice(0, 100).flatMap((item) => {
        if (typeof item === "string") { const url = safePublicUrl(item); return url ? [{ url }] : []; }
        const citation = record(item);
        const url = safePublicUrl(citation.url);
        return url ? [{ url, title: boundedString(citation.title, 500), snippet: boundedString(citation.snippet, 1_500) }] : [];
      }) : [], terminationReason: boundedString(finalResult.termination_reason, 120), contentIsUntrusted: true };
    },

    async startResearch(input: { query: string; mode?: "standard" | "deep"; outputLanguage?: string; domainType?: "web" | "news" | "research_paper"; afterDate?: string; beforeDate?: string; recencyMinutes?: number; includeDomains?: string[]; excludeDomains?: string[]; onRunCreated: (id: string) => Promise<void> }, signal?: AbortSignal) {
      const query = input.query.trim();
      if (query.length < 1 || query.length > 2_000) throw new Error("TinyFish Research query must contain 1 to 2,000 characters.");
      if (input.recencyMinutes !== undefined && (input.afterDate || input.beforeDate)) throw new Error("Use recencyMinutes or a date range, not both.");
      if (input.domainType === "research_paper" && (input.recencyMinutes !== undefined || input.afterDate || input.beforeDate)) throw new Error("Research-paper queries use publication-year filters, not date or recency filters.");
      if (input.recencyMinutes !== undefined && (!Number.isInteger(input.recencyMinutes) || input.recencyMinutes < 1 || input.recencyMinutes > 5_256_000)) throw new Error("recencyMinutes must be an integer from 1 to 5256000.");
      if (input.afterDate && !validCalendarDate(input.afterDate)) throw new Error("afterDate must be a valid YYYY-MM-DD calendar date.");
      if (input.beforeDate && !validCalendarDate(input.beforeDate)) throw new Error("beforeDate must be a valid YYYY-MM-DD calendar date.");
      if (input.afterDate && input.beforeDate && input.afterDate > input.beforeDate) throw new Error("afterDate must be on or before beforeDate.");
      const payload: Record<string, unknown> = { query, mode: input.mode ?? "standard", stream: false };
      if (input.outputLanguage) payload.output_language = input.outputLanguage.slice(0, 35);
      if (input.domainType) payload.domain_type = input.domainType;
      if (input.afterDate) payload.after_date = input.afterDate;
      if (input.beforeDate) payload.before_date = input.beforeDate;
      if (input.recencyMinutes !== undefined) payload.recency_minutes = input.recencyMinutes;
      if (input.includeDomains?.length) payload.domain_filter = { include_domains: input.includeDomains.slice(0, 20).map(validateDomain) };
      if (input.excludeDomains?.length) payload.domain_filter = { ...record(payload.domain_filter), exclude_domains: input.excludeDomains.slice(0, 20).map(validateDomain) };
      const response = await fetcher(`${AGENT_URL}/v1/automation/run-research`, {
        method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), redirect: "error",
      });
      if (!response.ok) { await readBoundedJson(response); throw new Error(`TinyFish Research request failed with HTTP ${response.status}.`); }
      let runId: string | undefined;
      await sseJsonEvents(response, signal, async (event) => {
        if (event.event !== "created" || typeof event.research_run_id !== "string") return false;
        runId = event.research_run_id.slice(0, 160);
        await input.onRunCreated(runId);
        return true;
      });
      if (!runId) throw new Error("TinyFish Research ended before it provided a saved run ID.");
      return { researchRunId: runId, status: "RUNNING" as const };
    },

    async getResearchRun(id: string) { return record(await request(`${AGENT_URL}/v1/research-run/${encodeURIComponent(id)}`, { method: "GET", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000)); },
    async listResearchRuns(options: { limit?: number; cursor?: string; status?: string; query?: string } = {}) {
      const params = new URLSearchParams({ limit: String(options.limit ?? 20), sort_direction: "desc" });
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.status) params.set("status", options.status);
      if (options.query) params.set("query", options.query.slice(0, 500));
      return record(await request(`${AGENT_URL}/v1/research-run?${params}`, { method: "GET", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000));
    },
    async cancelResearchRun(id: string) { return record(await request(`${AGENT_URL}/v1/research-run/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000)); },

    async createMonitor(input: TinyFishMonitorInput) {
      return record(await request(`${MONITOR_URL}/v1/monitors`, { method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(input) }, 60_000));
    },
    async listMonitors() { return record(await request(`${MONITOR_URL}/v1/monitors`, { method: "GET", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000)); },
    async getMonitor(id: string) { return record(await request(`${MONITOR_URL}/v1/monitors/${encodeURIComponent(id)}`, { method: "GET", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000)); },
    async updateMonitor(id: string, patch: Record<string, unknown>) { return record(await request(`${MONITOR_URL}/v1/monitors/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(patch) }, 30_000)); },
    async deleteMonitor(id: string) { return record(await request(`${MONITOR_URL}/v1/monitors/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 30_000)); },
    async runMonitorNow(id: string) { return record(await request(`${MONITOR_URL}/v1/monitors/${encodeURIComponent(id)}/runs`, { method: "POST", headers: { "X-API-Key": apiKey, Accept: "application/json" } }, 150_000)); },
  };
}
