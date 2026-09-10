import type { ShoppingCategory, ShoppingRetailer } from "./types.js";

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
  { id: "best-buy", name: "Best Buy", origin: "https://www.bestbuy.com", countries: ["US", "CA"], categories: ["electronics", "home"], supportsDelivery: true, supportsPickup: true },
  // United Kingdom and Ireland
  { id: "hellofresh", name: "HelloFresh", origin: "https://www.hellofresh.com", countries: ["US", "GB", "CA", "AU", "DE", "FR", "NL"], categories: ["meal_kit"], supportsDelivery: true, supportsPickup: false },
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

export function getRetailer(value: string): ShoppingRetailer | undefined {
  const target = key(value);
  return RETAILERS.find((retailer) => retailer.id === target || key(retailer.name) === target || key(retailer.origin) === target);
}

export function suggestRetailers(input: { country?: string; category: ShoppingCategory; deliveryPreference?: "delivery" | "pickup" | "either" }): ShoppingRetailer[] {
  const country = input.country?.trim().toUpperCase();
  const matching = RETAILERS.filter((retailer) => retailer.categories.includes(input.category))
    .filter((retailer) => !country || retailer.countries.includes(country))
    .filter((retailer) => input.deliveryPreference !== "delivery" || retailer.supportsDelivery)
    .filter((retailer) => input.deliveryPreference !== "pickup" || retailer.supportsPickup);
  return matching.slice(0, 5);
}

export function retailerCatalogue(): ShoppingRetailer[] { return RETAILERS.map((retailer) => ({ ...retailer, countries: [...retailer.countries], categories: [...retailer.categories] })); }
