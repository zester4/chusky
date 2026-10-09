import type { ShoppingCategory, ShoppingRetailer, ShoppingWorkflow } from "./types.js";

/** Curated starting points only. Chusky may use any explicit HTTPS retailer. */
const RETAILERS: ShoppingRetailer[] = [
  // North America
  { id: "instacart", name: "Instacart", origin: "https://www.instacart.com", countries: ["US", "CA"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "walmart", name: "Walmart", origin: "https://www.walmart.com", countries: ["US"], categories: ["groceries", "household", "electronics", "fashion", "home", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "amazon", name: "Amazon", origin: "https://www.amazon.com", countries: ["US", "GB", "CA", "DE", "FR", "IT", "ES", "JP", "AU"], categories: ["groceries", "household", "electronics", "fashion", "home", "health_beauty", "other"], supportsDelivery: true, supportsPickup: false },
  { id: "amazon-fresh", name: "Amazon Fresh", origin: "https://www.amazon.com", countries: ["US", "GB"], categories: ["groceries", "household"], supportsDelivery: true, supportsPickup: true },
  { id: "target", name: "Target", origin: "https://www.target.com", countries: ["US"], categories: ["groceries", "household", "electronics", "fashion", "home", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "kroger", name: "Kroger", origin: "https://www.kroger.com", countries: ["US"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "costco", name: "Costco", origin: "https://www.costco.com", countries: ["US", "CA"], categories: ["groceries", "household", "electronics", "home", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "doordash", name: "DoorDash", origin: "https://www.doordash.com", countries: ["US", "CA", "AU"], categories: ["groceries", "household", "health_beauty", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "ubereats", name: "Uber Eats", origin: "https://www.ubereats.com", countries: ["US", "CA", "AU", "GB", "FR", "DE", "ES", "IT", "JP", "BR", "MX"], categories: ["groceries", "restaurant_delivery", "household", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "grubhub", name: "Grubhub", origin: "https://www.grubhub.com", countries: ["US"], categories: ["restaurant_delivery", "groceries", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "dominos", name: "Domino's", origin: "https://www.dominos.com", countries: ["US", "CA", "GB", "AU", "NZ"], categories: ["restaurant_delivery"], supportsDelivery: true, supportsPickup: true },
  { id: "gopuff", name: "Gopuff", origin: "https://gopuff.com", countries: ["US", "GB"], categories: ["groceries", "restaurant_delivery", "household", "health_beauty", "other"], supportsDelivery: true, supportsPickup: false },
  { id: "shipt", name: "Shipt", origin: "https://www.shipt.com", countries: ["US"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: false },
  { id: "freshdirect", name: "FreshDirect", origin: "https://www.freshdirect.com", countries: ["US"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: false },
  { id: "best-buy", name: "Best Buy", origin: "https://www.bestbuy.com", countries: ["US", "CA"], categories: ["electronics", "home"], supportsDelivery: true, supportsPickup: true },
  // Travel, connectivity, and digital services. These entries provide safe
  // domain routing and review semantics; live availability and account state
  // must still be confirmed by the browser on every run.
  { id: "united-airlines", name: "United Airlines", origin: "https://www.united.com", countries: ["US", "CA", "GB", "MX", "DE", "JP"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "delta", name: "Delta", origin: "https://www.delta.com", countries: ["US", "CA", "GB", "MX"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "american-airlines", name: "American Airlines", origin: "https://www.aa.com", countries: ["US", "CA", "MX", "GB"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "southwest", name: "Southwest", origin: "https://www.southwest.com", countries: ["US", "MX"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "alaska-airlines", name: "Alaska Airlines", origin: "https://www.alaskaair.com", countries: ["US", "CA", "MX"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "jetblue", name: "JetBlue", origin: "https://www.jetblue.com", countries: ["US", "CA", "MX", "GB"], categories: ["flights"], supportsDelivery: false, supportsPickup: false },
  { id: "airbnb", name: "Airbnb", origin: "https://www.airbnb.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP", "MX"], categories: ["stays"], supportsDelivery: false, supportsPickup: false },
  { id: "booking-com", name: "Booking.com", origin: "https://www.booking.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP", "MX"], categories: ["stays"], supportsDelivery: false, supportsPickup: false },
  { id: "expedia", name: "Expedia", origin: "https://www.expedia.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP", "MX"], categories: ["stays", "flights"], supportsDelivery: false, supportsPickup: false },
  { id: "verizon", name: "Verizon", origin: "https://www.verizon.com", countries: ["US"], categories: ["telecom"], supportsDelivery: false, supportsPickup: false },
  { id: "t-mobile", name: "T-Mobile", origin: "https://www.t-mobile.com", countries: ["US"], categories: ["telecom"], supportsDelivery: false, supportsPickup: false },
  { id: "att", name: "AT&T", origin: "https://www.att.com", countries: ["US"], categories: ["telecom"], supportsDelivery: false, supportsPickup: false },
  { id: "netflix", name: "Netflix", origin: "https://www.netflix.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP", "MX"], categories: ["streaming"], supportsDelivery: false, supportsPickup: false },
  { id: "disney-plus", name: "Disney+", origin: "https://www.disneyplus.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP"], categories: ["streaming"], supportsDelivery: false, supportsPickup: false },
  { id: "hulu", name: "Hulu", origin: "https://www.hulu.com", countries: ["US"], categories: ["streaming"], supportsDelivery: false, supportsPickup: false },
  { id: "max", name: "Max", origin: "https://www.max.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "MX"], categories: ["streaming"], supportsDelivery: false, supportsPickup: false },
  // United Kingdom and Ireland
  { id: "hellofresh", name: "HelloFresh", origin: "https://www.hellofresh.com", countries: ["US", "GB", "CA", "AU", "DE", "FR", "NL"], categories: ["meal_kit"], supportsDelivery: true, supportsPickup: false },
  { id: "blue-apron", name: "Blue Apron", origin: "https://www.blueapron.com", countries: ["US"], categories: ["meal_kit"], supportsDelivery: true, supportsPickup: false },
  { id: "factor", name: "Factor", origin: "https://www.factor75.com", countries: ["US", "CA"], categories: ["meal_kit"], supportsDelivery: true, supportsPickup: false },
  { id: "just-eat", name: "Just Eat", origin: "https://www.just-eat.co.uk", countries: ["GB", "IE", "DE", "NL", "FR", "ES", "IT", "AU"], categories: ["restaurant_delivery", "groceries", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "tesco", name: "Tesco", origin: "https://www.tesco.com", countries: ["GB"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "sainsburys", name: "Sainsbury's", origin: "https://www.sainsburys.co.uk", countries: ["GB"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "ocado", name: "Ocado", origin: "https://www.ocado.com", countries: ["GB"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: false },
  { id: "asda", name: "Asda", origin: "https://www.asda.com", countries: ["GB"], categories: ["groceries", "household", "fashion", "home", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "morrisons", name: "Morrisons", origin: "https://groceries.morrisons.com", countries: ["GB"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "waitrose", name: "Waitrose", origin: "https://www.waitrose.com", countries: ["GB"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  // Continental Europe. Availability differs by locality; Chusky still confirms
  // a user's delivery area on the retailer site before claiming it can serve it.
  { id: "carrefour", name: "Carrefour", origin: "https://www.carrefour.com", countries: ["FR", "ES", "IT", "BE", "PL", "RO"], categories: ["groceries", "household", "health_beauty", "home"], supportsDelivery: true, supportsPickup: true },
  { id: "rewe", name: "REWE", origin: "https://www.rewe.de", countries: ["DE"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "albert-heijn", name: "Albert Heijn", origin: "https://www.ah.nl", countries: ["NL"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
  { id: "bol", name: "bol", origin: "https://www.bol.com", countries: ["NL", "BE"], categories: ["electronics", "fashion", "home", "health_beauty", "other"], supportsDelivery: true, supportsPickup: false },
  { id: "zalando", name: "Zalando", origin: "https://www.zalando.com", countries: ["DE", "FR", "IT", "ES", "NL", "BE", "PL", "SE", "DK", "AT", "CH", "IE", "GB"], categories: ["fashion", "health_beauty", "home"], supportsDelivery: true, supportsPickup: false },
  { id: "ikea", name: "IKEA", origin: "https://www.ikea.com", countries: ["GB", "DE", "FR", "ES", "IT", "NL", "BE", "SE", "PL", "US", "CA", "AU"], categories: ["home", "household"], supportsDelivery: true, supportsPickup: true },
  { id: "wolt", name: "Wolt", origin: "https://wolt.com", countries: ["FI", "SE", "DK", "NO", "DE", "PL", "HR", "GR", "HU", "GE", "IL"], categories: ["groceries", "household", "health_beauty", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "opentable", name: "OpenTable", origin: "https://www.opentable.com", countries: ["US", "CA", "GB", "AU", "DE", "FR", "ES", "IT", "JP", "MX"], categories: ["dining_reservations"], supportsDelivery: false, supportsPickup: false },
  { id: "resy", name: "Resy", origin: "https://resy.com", countries: ["US", "CA", "GB"], categories: ["dining_reservations"], supportsDelivery: false, supportsPickup: false },
  // Africa
  { id: "jumia-ghana", name: "Jumia Ghana", origin: "https://www.jumia.com.gh", countries: ["GH"], categories: ["electronics", "fashion", "home", "health_beauty", "household", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "jumia-nigeria", name: "Jumia Nigeria", origin: "https://www.jumia.com.ng", countries: ["NG"], categories: ["electronics", "fashion", "home", "health_beauty", "household", "other"], supportsDelivery: true, supportsPickup: true },
  { id: "takealot", name: "Takealot", origin: "https://www.takealot.com", countries: ["ZA"], categories: ["electronics", "fashion", "home", "health_beauty", "household", "other"], supportsDelivery: true, supportsPickup: true },
  // Asia-Pacific
  { id: "flipkart", name: "Flipkart", origin: "https://www.flipkart.com", countries: ["IN"], categories: ["electronics", "fashion", "home", "health_beauty", "other"], supportsDelivery: true, supportsPickup: false },
  { id: "bigbasket", name: "bigbasket", origin: "https://www.bigbasket.com", countries: ["IN"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: false },
  { id: "woolworths-au", name: "Woolworths Australia", origin: "https://www.woolworths.com.au", countries: ["AU"], categories: ["groceries", "household", "health_beauty"], supportsDelivery: true, supportsPickup: true },
];

function key(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function workflowForCategory(category: ShoppingCategory): ShoppingWorkflow {
  if (category === "flights") return "flight_search";
  if (category === "stays") return "stay_search";
  if (category === "telecom") return "service_plan";
  if (category === "streaming") return "streaming_account";
  if (category === "dining_reservations") return "reservation";
  if (category === "meal_kit") return "meal_plan";
  return "product_cart";
}

export function shoppingWorkflowFor(retailer: Pick<ShoppingRetailer, "categories" | "workflow">, preferredCategory?: ShoppingCategory): ShoppingWorkflow {
  if (preferredCategory && retailer.categories.includes(preferredCategory)) return workflowForCategory(preferredCategory);
  if (retailer.workflow) return retailer.workflow;
  const category = retailer.categories.find((value) => ["flights", "stays", "telecom", "streaming", "dining_reservations", "meal_kit"].includes(value)) ?? retailer.categories[0] ?? "other";
  return workflowForCategory(category);
}

export function getRetailer(value: string, preferredCategory?: ShoppingCategory): ShoppingRetailer | undefined {
  const target = key(value);
  const retailer = RETAILERS.find((item) => item.id === target || key(item.name) === target || key(item.origin) === target);
  return retailer ? { ...retailer, workflow: shoppingWorkflowFor(retailer, preferredCategory) } : undefined;
}

export function suggestRetailers(input: { country?: string; category: ShoppingCategory; deliveryPreference?: "delivery" | "pickup" | "either" }): ShoppingRetailer[] {
  const country = input.country?.trim().toUpperCase();
  const matching = RETAILERS.filter((retailer) => retailer.categories.includes(input.category))
    .filter((retailer) => !country || retailer.countries.includes(country))
    .filter((retailer) => input.deliveryPreference !== "delivery" || retailer.supportsDelivery)
    .filter((retailer) => input.deliveryPreference !== "pickup" || retailer.supportsPickup);
  // Keep enough candidates to include both local specialists and broad
  // platforms (for example Tesco plus Amazon in GB, or DoorDash plus
  // Domino's in the US) without returning the entire catalogue.
  return matching.slice(0, 8).map((retailer) => ({ ...retailer, workflow: shoppingWorkflowFor(retailer) }));
}

export function retailerCatalogue(): ShoppingRetailer[] { return RETAILERS.map((retailer) => ({ ...retailer, workflow: shoppingWorkflowFor(retailer), countries: [...retailer.countries], categories: [...retailer.categories] })); }
