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
  strategy: "direct-search" | "bootstrap-search" | "direct-location" | "direct-page";
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

function pathQueryAdapter(id: string, name: string, origin: string, category: ShoppingCategory, pathname: string): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "direct-search",
    buildUrl: (request) => {
      const query = requiredText(cleanQuery(request), "query", QUERY_MAX);
      return originUrl(origin, `${pathname.replace(/\/$/, "")}/${encodeURIComponent(query)}`);
    },
    buildSteps: () => [],
  };
}

function pageAdapter(id: string, name: string, origin: string, category: ShoppingCategory, pathname = "/"): SiteEntryAdapter {
  return {
    id,
    name,
    origin,
    categories: [category],
    strategy: "direct-page",
    buildUrl: () => originUrl(origin, pathname),
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
  queryAdapter("ebay", "eBay", "https://www.ebay.com", "other", "/sch/i.html", "_nkw"),
  pathQueryAdapter("homedepot", "The Home Depot", "https://www.homedepot.com", "home", "/s"),
  queryAdapter("lowes", "Lowe's", "https://www.lowes.com", "home", "/search", "searchTerm"),
  pageAdapter("macys", "Macy's", "https://www.macys.com", "fashion", "/shop/featured/mens-shirts"),
  queryAdapter("chewy", "Chewy", "https://www.chewy.com", "other", "/s", "query"),
  queryAdapter("kohls", "Kohl's", "https://www.kohls.com", "fashion", "/search.jsp", "search"),
  pageAdapter("kayak", "KAYAK", "https://www.kayak.com", "flights", "/flights"),
  pageAdapter("skyscanner", "Skyscanner", "https://www.skyscanner.com", "flights", "/transport/flights/"),
  pageAdapter("gitlab", "GitLab", "https://gitlab.com", "other", "/explore"),
  queryAdapter("ikea", "IKEA", "https://www.ikea.com", "home", "/us/en/search/", "q"),
  queryAdapter("bh-photo", "B&H Photo", "https://www.bhphotovideo.com", "electronics", "/c/search", "Ntt"),
  queryAdapter("newegg", "Newegg", "https://www.newegg.com", "electronics", "/p/pl", "d"),
  pathQueryAdapter("dell", "Dell", "https://www.dell.com", "electronics", "/en-us/search"),
  queryAdapter("lenovo", "Lenovo", "https://www.lenovo.com", "electronics", "/us/en/search", "text"),
  queryAdapter("nike", "Nike", "https://www.nike.com", "fashion", "/w", "q"),
  queryAdapter("adidas", "adidas", "https://www.adidas.com", "fashion", "/us/search", "q"),
  queryAdapter("uniqlo", "UNIQLO", "https://www.uniqlo.com", "fashion", "/us/en/search", "q"),
  queryAdapter("sephora", "Sephora", "https://www.sephora.com", "health_beauty", "/search", "keyword"),
  queryAdapter("ulta", "Ulta Beauty", "https://www.ulta.com", "health_beauty", "/search", "search"),
  queryAdapter("cvs", "CVS", "https://www.cvs.com", "health_beauty", "/search", "searchTerm"),
  queryAdapter("walgreens", "Walgreens", "https://www.walgreens.com", "health_beauty", "/search/results.jsp", "Ntt"),
  queryAdapter("staples", "Staples", "https://www.staples.com", "household", "/search", "query"),
  queryAdapter("office-depot", "Office Depot", "https://www.officedepot.com", "household", "/a/search/", "q"),
  pathQueryAdapter("sainsburys", "Sainsbury's", "https://www.sainsburys.co.uk", "groceries", "/gol-ui/SearchResults"),
  queryAdapter("takealot", "Takealot", "https://www.takealot.com", "other", "/all", "search"),
  queryAdapter("google", "Google", "https://www.google.com", "other", "/search", "q"),
  queryAdapter("bing", "Bing", "https://www.bing.com", "other", "/search", "q"),
  queryAdapter("duckduckgo", "DuckDuckGo", "https://duckduckgo.com", "other", "/", "q"),
  queryAdapter("mozilla", "MDN Search", "https://developer.mozilla.org", "other", "/en-US/search", "q"),
  pageAdapter("mdn", "MDN Web API", "https://developer.mozilla.org", "other", "/en-US/docs/Web/API"),
  queryAdapter("python", "Python", "https://www.python.org", "other", "/search/", "q"),
  pageAdapter("nodejs", "Node.js", "https://nodejs.org", "other", "/en/learn/getting-started/introduction-to-nodejs"),
  pageAdapter("react", "React", "https://react.dev", "other", "/learn"),
  pageAdapter("vue", "Vue", "https://vuejs.org", "other", "/guide/introduction.html"),
  pageAdapter("svelte", "Svelte", "https://svelte.dev", "other", "/docs/svelte/overview"),
  pageAdapter("typescript", "TypeScript", "https://www.typescriptlang.org", "other", "/docs/handbook/intro.html"),
  pageAdapter("docker", "Docker Docs", "https://docs.docker.com", "other", "/get-started/"),
  pageAdapter("kubernetes", "Kubernetes", "https://kubernetes.io", "other", "/docs/home/"),
  pageAdapter("cloudflare", "Cloudflare Developers", "https://developers.cloudflare.com", "other", "/"),
  pageAdapter("bbc", "BBC News", "https://www.bbc.com", "other", "/news"),
  pageAdapter("wikipedia", "Wikipedia", "https://en.wikipedia.org", "other", "/wiki/Browser_automation"),
  pageAdapter("microsoft-learn", "Microsoft Learn", "https://learn.microsoft.com", "other", "/en-us/search/?terms=playwright"),
  pageAdapter("stripe", "Stripe Docs", "https://docs.stripe.com", "other", "/"),
  pageAdapter("guardian", "The Guardian", "https://www.theguardian.com", "other", "/international"),
  pageAdapter("google-cloud", "Google Cloud", "https://cloud.google.com", "other", "/docs"),
  pageAdapter("supabase", "Supabase", "https://supabase.com", "other", "/docs"),
  pageAdapter("espn", "ESPN", "https://www.espn.com", "other", "/"),
  pageAdapter("cnbc", "CNBC", "https://www.cnbc.com", "other", "/"),
  pageAdapter("yahoo-finance", "Yahoo Finance", "https://finance.yahoo.com", "other", "/"),
  pageAdapter("coinmarketcap", "CoinMarketCap", "https://coinmarketcap.com", "other", "/"),
  pageAdapter("redfin", "Redfin", "https://www.redfin.com", "other", "/"),
  pageAdapter("indeed", "Indeed", "https://www.indeed.com", "other", "/"),
  pageAdapter("coursera", "Coursera", "https://www.coursera.org", "other", "/courses"),
  pageAdapter("allrecipes", "Allrecipes", "https://www.allrecipes.com", "other", "/"),
  pageAdapter("foodnetwork", "Food Network", "https://www.foodnetwork.com", "other", "/"),
  pageAdapter("aliexpress", "AliExpress", "https://www.aliexpress.com", "other", "/"),
  pageAdapter("samsung", "Samsung", "https://www.samsung.com", "other", "/us"),
  pageAdapter("autotrader", "Autotrader", "https://www.autotrader.com", "other", "/cars-for-sale"),
  pageAdapter("cars", "Cars.com", "https://www.cars.com", "other", "/"),
  pageAdapter("rust", "Rust", "https://www.rust-lang.org", "other", "/learn"),
  pageAdapter("go", "Go", "https://go.dev", "other", "/learn/"),
  pageAdapter("ruby", "Ruby", "https://www.ruby-lang.org", "other", "/en/documentation/"),
  pageAdapter("php", "PHP", "https://www.php.net", "other", "/docs.php"),
  pageAdapter("perl", "Perl", "https://www.perl.org", "other", "/"),
  pageAdapter("swift", "Swift", "https://www.swift.org", "other", "/documentation/"),
  pageAdapter("kotlin", "Kotlin", "https://kotlinlang.org", "other", "/docs/home.html"),
  pageAdapter("dart", "Dart", "https://dart.dev", "other", "/language"),
  pageAdapter("flutter", "Flutter", "https://docs.flutter.dev", "other", "/get-started/learn-flutter"),
  pageAdapter("angular", "Angular", "https://angular.dev", "other", "/overview"),
  pageAdapter("nextjs", "Next.js", "https://nextjs.org", "other", "/docs"),
  pageAdapter("playwright", "Playwright", "https://playwright.dev", "other", "/docs/intro"),
  pageAdapter("pytest", "pytest", "https://docs.pytest.org", "other", "/en/stable/"),
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
