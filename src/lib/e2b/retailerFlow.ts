export type RetailerFlowMatch = {
  role?: string;
  name?: string;
  href?: string;
  id?: string;
  index?: number;
  frameIndex?: number;
  frameUrl?: string;
  disabled?: boolean;
  [key: string]: unknown;
};

type ProductObservation = {
  matches?: RetailerFlowMatch[];
  links?: RetailerFlowMatch[];
  forms?: Array<{ controls?: RetailerFlowMatch[]; submitControls?: RetailerFlowMatch[] }>;
};

const productPath = /(?:\/ip\/|\/product(?:s)?\/|\/item(?:s)?\/|\/p\/|\/dp\/|\/buy\/|\/catalog\/|\/shop\/|\/sku(?:s)?\/|product[._-]|item[._-]|sku[._-]|\.html(?:$|[?#]))/i;
const excludedPath = /(?:\/search(?:\/|[?#]|$)|searchpage|\/category(?:\/|[?#]|$)|\/brand(?:\/|[?#]|$)|\/stores?(?:\/|[?#]|$)|\/account(?:\/|[?#]|$)|\/customer(?:\/|[?#]|$)|\/help(?:\/|[?#]|$)|\/locations?(?:\/|[?#]|$)|\/careers?(?:\/|[?#]|$)|\/privacy(?:\/|[?#]|$)|\/legal(?:\/|[?#]|$)|\/services?(?:\/|[?#]|$)|\/blocked(?:\/|[?#]|$))/i;
const productName = /\b(?:shirt|cap|hat|trouser|sweater|phone|iphone|laptop|computer|mouse|keyboard|headphone|monitor|television|tv|shoe|jacket|dress|product|item)\b/i;
const variantName = /\b(?:color|colour|size|storage|capacity|model|memory|finish|style|flavor|flavour|configuration|variant|plan|choose|select|black|white|blue|red|green|silver|gold|titanium|natural)\b|\b(?:xs|s|m|l|xl|xxl|64gb|128gb|256gb|512gb|1tb|2tb)\b/i;
const nonVariantName = /\b(?:favorite|favourite|wishlist|compare|share|learn more|details|reviews?|not sure|how much|need help|why choose)\b/i;
const cartName = /(?:^\s*add(?:\s+item)?\s*$|\badd(?:ed)?\s+(?:to\s+)?(?:cart|bag)|add\s+for\s+(?:delivery|shipping)|cart|bag|continue\s+to\s+checkout|review\s+(?:cart|order))/i;

function text(value: unknown): string { return String(value ?? "").replace(/\s+/g, " ").trim(); }

function sameHost(href: string, base: string): boolean {
  try { return new URL(href, base).hostname.replace(/^www\./i, "").toLowerCase() === new URL(base).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return false; }
}

function queryTerms(base: string): string[] {
  try { return [...new URL(base).searchParams.values()].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !["search", "keyword", "searchterm", "query"].includes(term)); }
  catch { return []; }
}

export function interactiveMatches(observation: ProductObservation): RetailerFlowMatch[] {
  const formMatches = (observation.forms || []).flatMap((form) => [...(form.controls || []), ...(form.submitControls || [])]);
  const seen = new Set<string>();
  return [...(observation.matches || []), ...formMatches].filter((item) => {
    const key = [item.role, item.name, item.id, item.frameIndex, item.index].map(text).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(text(item.name));
  });
}

export function findProductCandidate(matches: RetailerFlowMatch[], base: string): string | undefined {
  const terms = queryTerms(base);
  const candidates = matches.filter((item) => String(item.role || "link") === "link" && text(item.href) && text(item.name)).map((item) => {
    const href = new URL(String(item.href), base).toString();
    const name = text(item.name);
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`;
    return { href, name, relevance: terms.filter((term) => `${name} ${path}`.toLowerCase().includes(term)).length, productSignal: productPath.test(path) ? 1 : 0, nameSignal: productName.test(name) ? 1 : 0, excluded: excludedPath.test(path) || url.pathname === "/" || url.pathname.startsWith("/blocked") };
  }).filter((item) => !item.excluded && sameHost(item.href, base)).sort((left, right) => (right.productSignal * 100 + right.relevance * 20 + right.nameSignal * 5) - (left.productSignal * 100 + left.relevance * 20 + left.nameSignal * 5));
  const best = candidates[0];
  return best && (best.productSignal > 0 || best.nameSignal > 0) ? best.href : undefined;
}

export function findVariantControl(matches: RetailerFlowMatch[]): RetailerFlowMatch | undefined {
  return matches.find((item) => ["button", "combobox", "radio", "option", "listbox", "switch"].includes(String(item.role)) && !item.disabled && !nonVariantName.test(text(item.name)) && variantName.test(text(item.name)));
}

export function findAddToCartControl(matches: RetailerFlowMatch[]): RetailerFlowMatch | undefined {
  return matches.filter((item) => ["button", "link"].includes(String(item.role)) && !item.disabled && cartName.test(text(item.name)) && !/^\s*(?:buy now|pay now|place order|submit order|complete purchase)\s*$/i.test(text(item.name))).sort((left, right) => Number(/\badd\b/i.test(text(right.name))) - Number(/\badd\b/i.test(text(left.name))))[0];
}

export function findFirstAvailableVariant(matches: RetailerFlowMatch[]): RetailerFlowMatch | undefined {
  return matches.find((item) => ["button", "option", "radio"].includes(String(item.role)) && !item.disabled && !cartName.test(text(item.name)) && !nonVariantName.test(text(item.name)) && variantName.test(text(item.name)) && text(item.name).length > 0);
}
