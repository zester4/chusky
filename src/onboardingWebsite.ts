import { assertSafeBrowserUrl } from "./lib/e2b/urlSafety.js";

const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 24_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

type UrlValidator = typeof assertSafeBrowserUrl;

export type PublicWebsiteSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  text: string;
};

export function normalizePublicWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value
    .replace(/&#(\d+);/g, (match, code: string) => {
      const numeric = Number(code);
      return Number.isFinite(numeric) ? String.fromCodePoint(Math.min(0x10ffff, numeric)) : match;
    })
    .replace(/&#x([\da-f]+);/gi, (match, code: string) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCodePoint(Math.min(0x10ffff, numeric)) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

export function extractPublicWebsiteText(raw: string, contentType: string): { title?: string; text: string } {
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) || /<\/?(?:html|body|main|title|h[1-6])\b/i.test(raw);
  if (!isHtml) return { text: raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS) };
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = decodeHtmlEntities(raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>|<\/div\s*>|<\/section\s*>|<\/h[1-6]\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { ...(title ? { title: decodeHtmlEntities(title).replace(/\s+/g, " ").trim().slice(0, 300) } : {}), text };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("The public website response exceeded the safety limit.");
  if (!response.body) return "";
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
        throw new Error("The public website response exceeded the safety limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchPublicWebsite(
  input: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  validateUrl: UrlValidator = assertSafeBrowserUrl,
): Promise<PublicWebsiteSnapshot> {
  const requestedUrl = normalizePublicWebsiteUrl(input);
  let current = await validateUrl(requestedUrl, { resolveDns: true });
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetcher(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal: requestSignal,
      headers: { Accept: "text/html, application/xhtml+xml, text/plain;q=0.9", "User-Agent": "Chusky-Onboarding/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("The public website redirected too many times.");
      current = await validateUrl(new URL(location, current).toString(), { resolveDns: true });
      continue;
    }
    if (!response.ok) throw new Error(`The public website returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) throw new Error("The public website did not return readable page text.");
    const extracted = extractPublicWebsiteText(await readBoundedBody(response), contentType);
    if (extracted.text.length < 20) throw new Error("The public website did not contain enough readable text.");
    return { requestedUrl, finalUrl: current.toString(), ...extracted };
  }
  throw new Error("The public website could not be read safely.");
}
