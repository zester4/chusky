import { isIP } from "node:net";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai/";
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
};

type FetchInput = {
  urls: string[];
  format?: "markdown" | "html" | "json";
  links?: boolean;
  imageLinks?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
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
    const url = boundedString(link.url ?? link.href, 2_000);
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

function assertPublicHttpUrl(value: string): string {
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
      if (input.recencyMinutes !== undefined && (input.afterDate || input.beforeDate)) throw new Error("Use recencyMinutes or a date range, not both.");
      if (input.afterDate && !validCalendarDate(input.afterDate)) throw new Error("afterDate must be a valid YYYY-MM-DD calendar date.");
      if (input.beforeDate && !validCalendarDate(input.beforeDate)) throw new Error("beforeDate must be a valid YYYY-MM-DD calendar date.");
      if (input.afterDate && input.beforeDate && input.afterDate > input.beforeDate) throw new Error("afterDate must be on or before beforeDate.");

      const params = new URLSearchParams({ query });
      if (input.location) params.set("location", input.location.slice(0, 100));
      if (input.language) params.set("language", input.language.slice(0, 20));
      if (input.recencyMinutes !== undefined) params.set("recency_minutes", String(input.recencyMinutes));
      if (input.afterDate) params.set("after_date", input.afterDate);
      if (input.beforeDate) params.set("before_date", input.beforeDate);
      if (input.page !== undefined) params.set("page", String(input.page));

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
          url: boundedString(result.url, 2_000),
        };
      }) : [];
      return { query: boundedString(payload.query, 500) ?? query, results, total_results: typeof payload.total_results === "number" ? payload.total_results : undefined, page: typeof payload.page === "number" ? payload.page : input.page ?? 0 };
    },

    async fetch(input: FetchInput, signal?: AbortSignal) {
      if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 5) throw new Error("TinyFish fetch accepts 1 to 5 URLs per request.");
      const urls = input.urls.map((value) => assertPublicHttpUrl(value));
      const payload = record(await request(FETCH_URL, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ urls, format: input.format ?? "markdown", links: input.links ?? false, image_links: input.imageLinks ?? false }),
        signal,
      }, 150_000));

      let remaining = MAX_FETCH_TEXT_CHARS;
      const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, urls.length).map((item) => {
        const result = record(item);
        const text = boundedString(result.text, Math.min(MAX_PAGE_TEXT_CHARS, Math.max(0, remaining))) ?? "";
        remaining = Math.max(0, remaining - text.length);
        return {
          url: boundedString(result.url, 2_000),
          final_url: boundedString(result.final_url, 2_000),
          title: boundedString(result.title, 500),
          description: boundedString(result.description, 1_000),
          language: boundedString(result.language, 40),
          author: boundedString(result.author, 200),
          published_date: boundedString(result.published_date, 80),
          format: boundedString(result.format, 20) ?? input.format ?? "markdown",
          text,
          truncated: typeof result.text === "string" && result.text.length > text.length,
          ...(input.links ? { links: boundedLinks(result.links, 30) } : {}),
          ...(input.imageLinks ? { image_links: boundedLinks(result.image_links, 20) } : {}),
        };
      });
      const errors = (Array.isArray(payload.errors) ? payload.errors : []).slice(0, urls.length).map((item) => {
        const error = record(item);
        return { url: boundedString(error.url, 2_000), error: boundedString(error.error, 500), status: typeof error.status === "number" ? error.status : undefined };
      });
      return { results, errors, contentIsUntrusted: true };
    },
  };
}
