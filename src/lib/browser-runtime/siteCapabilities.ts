/**
 * Site capabilities describe which legitimate execution routes are available
 * for an origin. This registry intentionally does not pretend that a public
 * API or WebMCP endpoint exists; callers must register those routes from
 * verified provider metadata before they can be selected.
 */
export type BrowserRoute = "api" | "oauth" | "webmcp" | "browser" | "owner-chrome" | "human-handoff" | "blocked";

export type SiteCapability = {
  origin: string;
  routes: BrowserRoute[];
  preferred: BrowserRoute;
  ownerChromeAllowed: boolean;
  reason?: string;
};

const MAX_CAPABILITIES = 200;

function originFrom(value: string | URL): string {
  let url: URL;
  try { url = typeof value === "string" ? new URL(value) : new URL(value.toString()); }
  catch { throw new Error("Browser site capability requires a valid URL"); }
  if (url.protocol !== "https:") throw new Error("Browser site capability requires HTTPS");
  if (url.username || url.password) throw new Error("Browser site capability cannot contain credentials");
  return url.origin;
}

export function normalizeBrowserOrigin(value: string | URL): string {
  return originFrom(value);
}

function normalizeCapability(input: SiteCapability): SiteCapability {
  const origin = originFrom(input.origin);
  if (!Array.isArray(input.routes)) throw new Error("Browser site capability routes must be an array");
  const routes = [...new Set(input.routes)].filter((route): route is BrowserRoute =>
    ["api", "oauth", "webmcp", "browser", "owner-chrome", "human-handoff", "blocked"].includes(route),
  );
  if (!routes.length || !routes.includes(input.preferred)) throw new Error("Browser site capability must declare a valid preferred route");
  if (input.preferred === "blocked" && routes.length !== 1) throw new Error("A blocked site capability cannot include another route");
  if (input.ownerChromeAllowed === true && !routes.includes("owner-chrome")) throw new Error("Owner Chrome must be declared as a site capability route");
  return {
    origin,
    routes,
    preferred: input.preferred,
    ownerChromeAllowed: input.ownerChromeAllowed === true,
    ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 240) } : {}),
  };
}

const COMMON_INTERACTIVE_ORIGINS = [
  "amazon.com", "target.com", "bestbuy.com", "expedia.com", "uber.com", "ubereats.com",
  "netflix.com", "airbnb.com", "booking.com", "walmart.com", "etsy.com", "linkedin.com",
  "github.com", "google.com", "microsoft.com", "apple.com",
];

function defaultCapability(origin: string): SiteCapability {
  return {
    origin,
    routes: ["browser", "human-handoff"],
    preferred: "browser",
    ownerChromeAllowed: false,
    reason: "Use the headed browser for interactive work and pause for a private human handoff when the site requires it.",
  };
}

/** Exact-origin and safe hostname-suffix registry for verified site routes. */
export class SiteCapabilityRegistry {
  private readonly entries = new Map<string, SiteCapability>();

  constructor(initial: SiteCapability[] = COMMON_INTERACTIVE_ORIGINS.map((hostname) => defaultCapability(`https://${hostname}`))) {
    for (const capability of initial) this.register(capability);
  }

  register(capability: SiteCapability): void {
    const normalized = normalizeCapability(capability);
    if (this.entries.size >= MAX_CAPABILITIES && !this.entries.has(normalized.origin)) throw new Error("Browser site capability registry is full");
    this.entries.set(normalized.origin, normalized);
  }

  remove(origin: string): boolean {
    return this.entries.delete(originFrom(origin));
  }

  resolve(value: string | URL): SiteCapability {
    const origin = originFrom(value);
    const exact = this.entries.get(origin);
    if (exact) return { ...exact, routes: [...exact.routes] };
    const hostname = new URL(origin).hostname;
    const suffix = [...this.entries.entries()].find(([registered]) => {
      const registeredHost = new URL(registered).hostname;
      return hostname.endsWith(`.${registeredHost}`);
    });
    if (suffix) return { ...suffix[1], origin, routes: [...suffix[1].routes] };
    return defaultCapability(origin);
  }

  list(): SiteCapability[] {
    return [...this.entries.values()].map((entry) => ({ ...entry, routes: [...entry.routes] }));
  }
}

export const browserSiteCapabilities = new SiteCapabilityRegistry();
