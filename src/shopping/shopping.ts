import { randomUUID } from "node:crypto";
import { createShoppingRun, findShoppingSite, getShoppingRun, listShoppingRuns, listShoppingSites, removeShoppingSite, saveShoppingSite, updateShoppingRun } from "../store.js";
import { getRetailer, suggestRetailers } from "./retailers.js";
import type { ShoppingCategory, ShoppingPauseReason, ShoppingRetailer, ShoppingRun, ShoppingSite } from "./types.js";

const CATEGORIES: ShoppingCategory[] = ["groceries", "household", "meal_kit", "fashion", "electronics", "health_beauty", "home", "other"];
const DELIVERY = ["delivery", "pickup", "either"] as const;

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} must be 1-${max} characters`);
  return value.trim();
}

function items(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("items must be an array");
  const result = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!result.length || result.length > 80 || result.some((item) => item.length > 240)) throw new Error("items must contain 1-80 non-empty items of at most 240 characters");
  return result;
}

function category(value: unknown): ShoppingCategory {
  if (value === undefined || value === null || value === "") return "other";
  if (typeof value !== "string" || !CATEGORIES.includes(value as ShoppingCategory)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
  }
  return value as ShoppingCategory;
}

function country(value: unknown): string | undefined {
  const result = text(value, "country", 2);
  if (result && !/^[a-z]{2}$/i.test(result)) throw new Error("country must be a two-letter country code, for example US or GB");
  return result?.toUpperCase();
}

function currency(value: unknown): string | undefined {
  const result = text(value, "currency", 3);
  if (result && !/^[a-z]{3}$/i.test(result)) throw new Error("currency must be a three-letter currency code, for example USD or GBP");
  return result?.toUpperCase();
}

function delivery(value: unknown): "delivery" | "pickup" | "either" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DELIVERY.includes(value as typeof DELIVERY[number])) throw new Error("deliveryPreference must be delivery, pickup, or either");
  return value as "delivery" | "pickup" | "either";
}

function money(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new Error("budget must be a positive number up to 1,000,000");
  return value;
}

function customRetailer(name: string, origin: string): ShoppingRetailer {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must be a clean HTTPS retailer origin");
  return { id: `custom-${url.hostname.toLowerCase()}`, name, origin: url.origin, countries: [], categories: ["other"], supportsDelivery: true, supportsPickup: true };
}

function listOfCodes(value: unknown, field: string, max: number, length: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must contain at most ${max} values`);
  const result = [...new Set(value.map((item) => String(item ?? "").trim().toUpperCase()).filter(Boolean))];
  if (result.some((item) => !new RegExp(`^[A-Z]{${length}}$`).test(item))) throw new Error(`${field} values must be ${length}-letter codes`);
  return result;
}

function categories(value: unknown): ShoppingCategory[] {
  if (value === undefined || value === null) return ["other"];
  if (!Array.isArray(value) || !value.length || value.length > CATEGORIES.length) throw new Error("categories must contain 1 or more supported shopping categories");
  return [...new Set(value.map((item) => category(item)))];
}

function bool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false`);
  return value;
}

function savedAsRetailer(site: ShoppingSite): ShoppingRetailer {
  return { id: site.id, name: site.name, origin: site.origin, countries: [...site.countries], categories: [...site.categories], supportsDelivery: site.supportsDelivery, supportsPickup: site.supportsPickup };
}

function questions(run: ShoppingRun): string[] {
  const result: string[] = [];
  if (!run.country) result.push("Which country or delivery area should I shop in?");
  if (!run.retailer) result.push("Which retailer should I use? I can suggest suitable options or use a retailer you name.");
  if (!run.deliveryPreference) result.push("Do you prefer delivery or pickup?");
  return result;
}

function view(run: ShoppingRun) {
  const suggestions = suggestRetailers({ country: run.country, category: run.category, deliveryPreference: run.deliveryPreference });
  return {
    ...run,
    suggestions,
    questions: questions(run),
    nextStep: run.retailer
      ? "Check the selected website in CHUCK_VAULT_LIST or CHUCK_VAULT_STATUS. If it is not connected, use CHUCK_VAULT_SAVE. Then use CHUCK_VAULT_LOGIN and CHUCK_DAYTONA_BROWSER."
      : "Ask the user to choose a retailer from the suggestions or name another HTTPS retailer. Do not ask for login credentials in chat.",
  };
}

export async function startShopping(userId: number, args: Record<string, unknown>) {
  const requestedRetailer = text(args.retailer, "retailer", 120);
  const knownRetailer = requestedRetailer ? getRetailer(requestedRetailer) : undefined;
  const run = await createShoppingRun(userId, {
    id: `shop_${randomUUID()}`,
    items: items(args.items),
    category: category(args.category),
    status: knownRetailer ? "awaiting_connection" : "awaiting_retailer",
    retailer: knownRetailer,
    country: country(args.country),
    city: text(args.city, "city", 120),
    postcode: text(args.postcode, "postcode", 32),
    budget: money(args.budget),
    currency: currency(args.currency),
    deliveryPreference: delivery(args.deliveryPreference),
    notes: text(args.notes, "notes", 1000),
  });
  return view(run);
}

export async function selectShoppingRetailer(userId: number, args: Record<string, unknown>) {
  const run = await getShoppingRun(userId, required(args.id, "id", 120));
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  if (run.status === "cancelled" || run.status === "completed") throw new Error("This shopping plan is no longer active");
  const name = required(args.retailer, "retailer", 120);
  const registered = await findShoppingSite(userId, name);
  const retailer = registered ? savedAsRetailer(registered) : getRetailer(name) ?? (args.origin ? customRetailer(name, required(args.origin, "origin", 300)) : undefined);
  if (!retailer) throw new Error("That retailer is not in the starter catalogue. Provide its clean HTTPS origin so Chusky can use it safely.");
  const updated = await updateShoppingRun(userId, run.id, { retailer, status: "awaiting_connection" });
  return view(updated!);
}

export async function saveShoppingSitePreference(userId: number, args: Record<string, unknown>) {
  const name = required(args.name, "name", 120);
  const retailer = customRetailer(name, required(args.origin, "origin", 300));
  const site = await saveShoppingSite(userId, {
    id: `site-${retailer.id.replace(/^custom-/, "")}`,
    name: retailer.name,
    origin: retailer.origin,
    countries: listOfCodes(args.countries, "countries", 25, 2),
    categories: categories(args.categories),
    supportsDelivery: bool(args.supportsDelivery, true, "supportsDelivery"),
    supportsPickup: bool(args.supportsPickup, true, "supportsPickup"),
  });
  return { ...site, message: "Site saved. This stores only its name and HTTPS origin; connect a website account separately only when you want Chusky to sign in." };
}

export async function listSavedShoppingSites(userId: number, limit?: number) { return listShoppingSites(userId, limit); }

export async function removeSavedShoppingSite(userId: number, id: string) {
  if (!await removeShoppingSite(userId, id)) throw new Error("Saved shopping site not found or not owned by you");
  return { id, removed: true, message: "Saved site removed. Any separately saved website login remains unchanged." };
}

export async function updateShopping(userId: number, args: Record<string, unknown>) {
  const run = await getShoppingRun(userId, required(args.id, "id", 120));
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  if (run.status === "cancelled" || run.status === "completed") throw new Error("This shopping plan is no longer active");
  const patch: Partial<ShoppingRun> = {};
  if (args.items !== undefined) patch.items = items(args.items);
  if (args.category !== undefined) patch.category = category(args.category);
  if (args.country !== undefined) patch.country = country(args.country);
  if (args.city !== undefined) patch.city = text(args.city, "city", 120);
  if (args.postcode !== undefined) patch.postcode = text(args.postcode, "postcode", 32);
  if (args.budget !== undefined) patch.budget = money(args.budget);
  if (args.currency !== undefined) patch.currency = currency(args.currency);
  if (args.deliveryPreference !== undefined) patch.deliveryPreference = delivery(args.deliveryPreference);
  if (args.notes !== undefined) patch.notes = text(args.notes, "notes", 1000);
  const updated = await updateShoppingRun(userId, run.id, patch);
  return view(updated!);
}

export async function listShopping(userId: number, limit?: number) { return (await listShoppingRuns(userId, limit)).map(view); }

export async function cancelShopping(userId: number, id: string) {
  const run = await getShoppingRun(userId, id);
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  const updated = await updateShoppingRun(userId, id, { status: "cancelled", completedAt: Date.now() });
  return { id: updated!.id, status: updated!.status, message: "Shopping plan cancelled. No browser cart or website account was changed." };
}

function pauseReason(value: unknown): ShoppingPauseReason {
  const allowed: ShoppingPauseReason[] = ["captcha", "two_factor", "age_verification", "site_challenge", "login", "user_requested"];
  if (typeof value !== "string" || !allowed.includes(value as ShoppingPauseReason)) throw new Error(`reason must be one of: ${allowed.join(", ")}`);
  return value as ShoppingPauseReason;
}

export async function pauseShopping(userId: number, args: Record<string, unknown>) {
  const run = await getShoppingRun(userId, required(args.id, "id", 120));
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  if (run.status === "cancelled" || run.status === "completed") throw new Error("This shopping plan is no longer active");
  const reason = pauseReason(args.reason);
  const updated = await updateShoppingRun(userId, run.id, { status: "awaiting_user_interaction", pausedReason: reason, pausedAt: Date.now() });
  return { ...view(updated!), message: "The shopping plan and the same Daytona browser session are preserved. Send ‘continue’ after you finish the private website step." };
}

export async function resumeShopping(userId: number, id: string) {
  const run = await getShoppingRun(userId, id);
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  if (run.status === "cancelled" || run.status === "completed") throw new Error("This shopping plan is no longer active");
  const updated = await updateShoppingRun(userId, run.id, { status: "shopping", pausedReason: undefined, pausedAt: undefined });
  return { ...view(updated!), message: "Shopping resumed in the retained browser. Inspect the current page before continuing; never repeat an already-completed action." };
}

function required(value: unknown, field: string, max: number): string {
  const result = text(value, field, max);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

export const SHOPPING_AGENT_PLAYBOOK = `
SHOPPING ENGINE
- Treat shopping as a general browser workflow, never as Amazon-only logic. Start a private shopping request with CHUCK_SHOPPING_START when the user asks to buy, order, restock, find, compare, or add physical goods to a cart.
- Ask only for missing decision-critical details: delivery country/area, retailer when more than one fits, delivery versus pickup, and budget or substitutions when relevant. If the user has named a retailer, respect it; otherwise use the shopping suggestions and, when necessary, live web research to propose current local options.
- After a retailer is chosen, call CHUCK_SHOPPING_SELECT_RETAILER. A user-owned saved site may be selected by name; use CHUCK_SHOPPING_SAVE_SITE to remember a clean HTTPS origin for future plans. Check CHUCK_VAULT_LIST or CHUCK_VAULT_STATUS. If that website is not connected, call CHUCK_VAULT_SAVE; never request a password in chat. If connected, call CHUCK_VAULT_LOGIN, then use CHUCK_DAYTONA_BROWSER to browse, search, compare, and add items to the cart.
- Use browser vaultAction=browse or search for ordinary navigation, and vaultAction=add_to_cart for cart changes. Verify every browser interaction with a snapshot or find result. A cart total, delivery slot, substitution, checkout, or order is not complete until the page confirms it.
- Cart building is autonomous. Checkout, payment, placing an order, changing an address, or adding a payment method stays behind the existing vault/browser approval policy. Never claim a purchase succeeded unless the retailer confirmation page proves it.
- If CAPTCHA, 2FA, age verification, or another user-only challenge appears, call CHUCK_SHOPPING_PAUSE and CHUCK_DAYTONA_BROWSER_HANDOFF. Send the returned short-lived private browser link only in the user's direct conversation. The user completes the website challenge in the same retained browser and replies “continue”; then call CHUCK_SHOPPING_RESUME and inspect the current page before any further action. Do not expose credentials, cookies, or session URLs in a shared group.
- If the user asks to see the browser, check progress, or take a screenshot without asking for another action, call CHUCK_DAYTONA_BROWSER with action=screenshot and stop. The screenshot is delivered through the active private channel; do not browse, click, or change the page beyond the explicit request.
`.trim();
