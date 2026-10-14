import type { ShoppingCategory } from "./types.js";

export type SiteEntryStep = {
  action: "fill" | "press" | "click" | "wait";
  selector?: {
    role?: "textbox" | "combobox" | "button" | "link" | "tab";
    name?: string;
    nameMatch?: "exact" | "substring" | "regex";
    placeholder?: string;
  };
  role?: "textbox" | "combobox" | "button" | "link" | "tab";
  name?: string;
  nameMatch?: "exact" | "substring" | "regex";
  value?: string;
  key?: string;
  textIncludes?: string;
  timeoutMs?: number;
};

export type SiteEntryRequest = {
  site?: string;
  retailer?: string;
  query?: string;
  location?: string;
  postcode?: string;
  country?: string;
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
};

export type SiteEntryAdapter = {
  id: string;
  name: string;
  origin: string;
  categories: readonly ShoppingCategory[];
  strategy: "direct-search" | "bootstrap-search" | "direct-location";
  buildUrl: (request: SiteEntryRequest) => URL;
  buildSteps: (request: SiteEntryRequest) => readonly SiteEntryStep[];
};

export type SiteEntryPlan = {
  adapterId: string;
  site: string;
  origin: string;
  category: ShoppingCategory;
  strategy: SiteEntryAdapter["strategy"];
  url: string;
  query?: string;
  location?: string;
  steps: readonly SiteEntryStep[];
  assertions: readonly { kind: "url" | "text" | "title"; value: string; required: boolean }[];
  fallback: { url: string; instruction: string };
};

const QUERY_MAX = 240;
const LOCATION_MAX = 180;

function key(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const result = value.replace(/\s+/g, " ").trim();
  if (!result) return undefined;
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result;
}

function requiredText(value: unknown, field: string, max: number): string {
  const result = text(value, field, max);
  if (!result) throw new Error(`${field} is required for this browser entry`);
  return result;
}

function cleanQuery(request: SiteEntryRequest): string | undefined {
  return text(request.query, "query", QUERY_MAX);
}

function cleanLocation(request: SiteEntryRequest): string | undefined {
  return text(request.location ?? request.postcode, "location", LOCATION_MAX);
}

function originUrl(origin: string, pathname = "/"): URL {
  const url = new URL(pathname, origin);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("site adapters may only create clean HTTPS URLs");
  return url;
}

function queryUrl(origin: string, pathname: string, parameter: string, request: SiteEntryRequest): URL {
  const query = requiredText(cleanQuery(request), "query", QUERY_MAX);
  const url = originUrl(origin, pathname);
  url.searchParams.set(parameter, query);
  return url;
}

function locationOrQuerySteps(request: SiteEntryRequest, searchName = "Search"): readonly SiteEntryStep[] {
  const query = cleanQuery(request);
  const location = cleanLocation(request);
  const steps: SiteEntryStep[] = [];
  if (location) {
    steps.push(
      { action: "fill", selector: { role: "textbox", name: "location", nameMatch: "substring" }, value: location },
      { action: "press", selector: { role: "textbox", name: "location", nameMatch: "substring" }, key: "Enter" },
    );
  }
  if (query) {
    steps.push(
      { action: "fill", selector: { role: "textbox", name: searchName, nameMatch: "substring" }, value: query },
      { action: "press", selector: { role: "textbox", name: searchName, nameMatch: "substring" }, key: "Enter" },
    );
  }
  return steps;
}

function searchSteps(request: SiteEntryRequest, searchName = "Search"): readonly SiteEntryStep[] {
  return locationOrQuerySteps(request, searchName);
}

function travelSteps(request: SiteEntryRequest, searchName = "Search", selectFlightsTab = false, placeholders?: { origin?: string; destination?: string }): readonly SiteEntryStep[] {
  const origin = text(request.origin, "origin", LOCATION_MAX);
  const destination = text(request.destination, "destination", LOCATION_MAX);
  const location = cleanLocation(request);
  const steps: SiteEntryStep[] = [];
  if (selectFlightsTab) steps.push({ action: "click", selector: { role: "tab", name: "Flights", nameMatch: "substring" } });
  if (origin) steps.push({ action: "fill", selector: placeholders?.origin ? { placeholder: placeholders.origin } : { role: "textbox", name: "(origin|from|leaving)", nameMatch: "regex" }, value: origin });
  if (destination || location) steps.push({ action: "fill", selector: placeholders?.destination ? { placeholder: placeholders.destination } : { role: "textbox", name: "(destination|to|going)", nameMatch: "regex" }, value: destination ?? location });
  if (request.departureDate) steps.push({ action: "fill", selector: { role: "textbox", name: "depart", nameMatch: "substring" }, value: requiredText(request.departureDate, "departureDate", 32) });
  if (request.returnDate) steps.push({ action: "fill", selector: { role: "textbox", name: "return", nameMatch: "substring" }, value: requiredText(request.returnDate, "returnDate", 32) });
  if (origin || destination || location || request.departureDate || request.returnDate) steps.push({ action: "click", selector: { role: "button", name: searchName, nameMatch: "substring" } });
  return steps;
}

function queryAdapter(
  id: string,
  name: string,
  origin: string,
  category: ShoppingCategory,
  pathname: string,
  parameter: string,
): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "direct-search",
    buildUrl: (request) => queryUrl(origin, pathname, parameter, request),
    buildSteps: () => [],
  };
}

function bootstrapAdapter(
  id: string,
  name: string,
  origin: string,
  category: ShoppingCategory,
  buildSteps: (request: SiteEntryRequest) => readonly SiteEntryStep[],
): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "bootstrap-search",
    buildUrl: (request) => originUrl(origin),
    buildSteps,
  };
}

function locationAdapter(id: string, name: string, origin: string, category: ShoppingCategory, pathname: string, parameter: string): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "direct-location",
    buildUrl: (request) => {
      const location = requiredText(cleanLocation(request), "location", LOCATION_MAX);
      const url = originUrl(origin, pathname);
      url.searchParams.set(parameter, location);
      return url;
    },
    buildSteps: () => [],
  };
}

function pathLocationAdapter(id: string, name: string, origin: string, category: ShoppingCategory, pathname: string): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "direct-location",
    buildUrl: (request) => {
      const location = requiredText(cleanLocation(request), "location", LOCATION_MAX);
      return originUrl(origin, `${pathname}/${encodeURIComponent(location)}/homes`);
    },
    buildSteps: () => [],
  };
}

/**
 * Fast entry points for the highest-value public shopping and service sites.
 * These adapters only choose the initial page. They never add payment data,
 * submit an order, or bypass a challenge. Every URL is rebuilt from bounded
 * user intent and must still be observed and verified by CHUCK_BROWSER.
 */
export const SITE_ADAPTERS: readonly SiteEntryAdapter[] = [
  queryAdapter("target", "Target", "https://www.target.com", "fashion", "/s", "searchTerm"),
  queryAdapter("walmart", "Walmart", "https://www.walmart.com", "fashion", "/search", "q"),
  queryAdapter("amazon", "Amazon", "https://www.amazon.com", "other", "/s", "k"),
  queryAdapter("best-buy", "Best Buy", "https://www.bestbuy.com", "electronics", "/site/searchpage.jsp", "st"),
  queryAdapter("costco", "Costco", "https://www.costco.com", "household", "/CatalogSearch", "keyword"),
  queryAdapter("tesco", "Tesco", "https://www.tesco.com", "groceries", "/shop/en-GB/search", "query"),
  queryAdapter("jumia-ghana", "Jumia Ghana", "https://www.jumia.com.gh", "fashion", "/catalog/", "q"),
  queryAdapter("instacart", "Instacart", "https://www.instacart.com", "groceries", "/store/s", "k"),
  queryAdapter("ubereats", "Uber Eats", "https://www.ubereats.com", "restaurant_delivery", "/search", "q"),
  queryAdapter("grubhub", "Grubhub", "https://www.grubhub.com", "restaurant_delivery", "/search", "query"),
  queryAdapter("just-eat", "Just Eat", "https://www.just-eat.co.uk", "restaurant_delivery", "/search", "query"),
  pathLocationAdapter("airbnb", "Airbnb", "https://www.airbnb.com", "stays", "/s"),
  locationAdapter("booking-com", "Booking.com", "https://www.booking.com", "stays", "/searchresults.html", "ss"),
  bootstrapAdapter("doordash", "DoorDash", "https://www.doordash.com", "restaurant_delivery", (request) => searchSteps(request, "Search")),
  bootstrapAdapter("dominos", "Domino's", "https://www.dominos.com", "restaurant_delivery", (request) => locationOrQuerySteps(request, "Search")),
  bootstrapAdapter("expedia", "Expedia", "https://www.expedia.com", "flights", (request) => travelSteps(request, "Search", true)),
  bootstrapAdapter("united-airlines", "United Airlines", "https://www.united.com", "flights", (request) => travelSteps(request, "Find flights", false, { origin: "Origin", destination: "Destination" })),
  bootstrapAdapter("delta", "Delta", "https://www.delta.com", "flights", (request) => travelSteps(request, "Find flights", false, { origin: "Origin", destination: "Destination" })),
  bootstrapAdapter("netflix", "Netflix", "https://www.netflix.com", "streaming", (request) => searchSteps(request, "Search")),
  bootstrapAdapter("disney-plus", "Disney+", "https://www.disneyplus.com", "streaming", (request) => searchSteps(request, "Search")),
] as const;

const ADAPTERS_BY_KEY = new Map(SITE_ADAPTERS.flatMap((adapter) => [
  [key(adapter.id), adapter],
  [key(adapter.name), adapter],
  [key(adapter.origin), adapter],
]));

export function getSiteAdapter(value: unknown): SiteEntryAdapter | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return ADAPTERS_BY_KEY.get(key(value));
}

export function buildSiteEntry(request: SiteEntryRequest): SiteEntryPlan {
  const adapter = getSiteAdapter(request.site ?? request.retailer);
  if (!adapter) throw new Error(`No browser site adapter is registered for '${String(request.site ?? request.retailer ?? "")}'. Choose one of: ${SITE_ADAPTERS.map((item) => item.id).join(", ")}`);
  const url = adapter.buildUrl(request);
  const query = cleanQuery(request);
  const location = cleanLocation(request);
  const steps = adapter.buildSteps(request);
  const assertions = [
    { kind: "url" as const, value: adapter.origin, required: true },
    ...(query ? [{ kind: "text" as const, value: query, required: false }] : []),
  ];
  return {
    adapterId: adapter.id,
    site: adapter.name,
    origin: adapter.origin,
    category: adapter.categories[0] ?? "other",
    strategy: adapter.strategy,
    url: url.toString(),
    ...(query ? { query } : {}),
    ...(location ? { location } : {}),
    steps,
    assertions,
    fallback: {
      url: adapter.origin,
      instruction: steps.length ? "Observe the page, re-resolve semantic controls, then retry only the missing bootstrap step." : "Observe the current page and use the generic browser search flow if the direct entry route was redirected or changed.",
    },
  };
}

export function siteAdapterCatalog(): Array<{ id: string; name: string; origin: string; categories: readonly ShoppingCategory[]; strategy: SiteEntryAdapter["strategy"] }> {
  return SITE_ADAPTERS.map(({ id, name, origin, categories, strategy }) => ({ id, name, origin, categories, strategy }));
}
