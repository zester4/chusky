import { randomUUID } from "node:crypto";
import { createShoppingRun, findShoppingSite, getShoppingRun, listShoppingRuns, listShoppingSites, removeShoppingSite, saveShoppingSite, updateShoppingRun } from "../store.js";
import { getRetailer, shoppingWorkflowFor, suggestRetailers } from "./retailers.js";
import type { ShoppingCategory, ShoppingDetails, ShoppingPauseReason, ShoppingRetailer, ShoppingRun, ShoppingSite } from "./types.js";

const CATEGORIES: ShoppingCategory[] = ["groceries", "household", "restaurant_delivery", "meal_kit", "dining_reservations", "fashion", "electronics", "health_beauty", "home", "flights", "stays", "telecom", "streaming", "other"];
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
  // Models commonly serialize an unspecified optional numeric constraint as 0.
  // Treat that placeholder as absent; never turn it into a real spending cap.
  if (value === 0) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new Error("budget must be a positive number up to 1,000,000");
  return value;
}

function isoDate(value: unknown, field: string): string | undefined {
  const result = text(value, field, 10);
  if (!result) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${field} must be an ISO date in YYYY-MM-DD format`);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new Error(`${field} must be a valid calendar date`);
  return result;
}

function integer(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return value;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field} is not supported`);
  return value as T;
}

function details(value: unknown, workflowCategory: ShoppingCategory): ShoppingDetails | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("details must be an object");
  if (!["flights", "stays", "telecom", "streaming"].includes(workflowCategory)) throw new Error("details are supported only for flights, stays, telecom, and streaming plans");
  const input = value as Record<string, unknown>;
  const allowed = workflowCategory === "flights"
    ? ["origin", "destination", "departureDate", "returnDate", "passengers", "cabin", "nonstop"]
    : workflowCategory === "stays"
      ? ["location", "checkIn", "checkOut", "guests", "rooms", "propertyType"]
      : workflowCategory === "telecom"
        ? ["serviceType", "lineCount", "dataNeed", "device", "monthlyBudget"]
        : ["action", "title", "genre", "profile", "planTier"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`details.${unknown} is not supported for ${workflowCategory}`);
  if (workflowCategory === "flights") {
    const origin = text(input.origin, "origin", 120);
    const destination = text(input.destination, "destination", 120);
    const departureDate = isoDate(input.departureDate, "departureDate");
    const returnDate = isoDate(input.returnDate, "returnDate");
    const passengers = integer(input.passengers, "passengers", 1, 9);
    const cabin = enumValue(input.cabin, "cabin", ["economy", "premium_economy", "business", "first"] as const);
    if (departureDate && returnDate && returnDate < departureDate) throw new Error("returnDate must be on or after departureDate");
    if (input.nonstop !== undefined && typeof input.nonstop !== "boolean") throw new Error("nonstop must be true or false");
    return {
      ...(origin ? { origin } : {}),
      ...(destination ? { destination } : {}),
      ...(departureDate ? { departureDate } : {}),
      ...(returnDate ? { returnDate } : {}),
      ...(passengers !== undefined ? { passengers } : {}),
      ...(cabin ? { cabin } : {}),
      ...(input.nonstop !== undefined ? { nonstop: input.nonstop as boolean } : {}),
    };
  }
  if (workflowCategory === "stays") {
    const location = text(input.location, "location", 160);
    const checkIn = isoDate(input.checkIn, "checkIn");
    const checkOut = isoDate(input.checkOut, "checkOut");
    const guests = integer(input.guests, "guests", 1, 20);
    const rooms = integer(input.rooms, "rooms", 1, 10);
    const propertyType = text(input.propertyType, "propertyType", 100);
    if (checkIn && checkOut && checkOut <= checkIn) throw new Error("checkOut must be after checkIn");
    return {
      ...(location ? { location } : {}),
      ...(checkIn ? { checkIn } : {}),
      ...(checkOut ? { checkOut } : {}),
      ...(guests !== undefined ? { guests } : {}),
      ...(rooms !== undefined ? { rooms } : {}),
      ...(propertyType ? { propertyType } : {}),
    };
  }
  if (workflowCategory === "telecom") {
    const serviceType = enumValue(input.serviceType, "serviceType", ["mobile", "home_internet", "bundle"] as const);
    const lineCount = integer(input.lineCount, "lineCount", 1, 20);
    const dataNeed = text(input.dataNeed, "dataNeed", 120);
    const device = text(input.device, "device", 160);
    const monthlyBudget = money(input.monthlyBudget);
    return {
      ...(serviceType ? { serviceType } : {}),
      ...(lineCount !== undefined ? { lineCount } : {}),
      ...(dataNeed ? { dataNeed } : {}),
      ...(device ? { device } : {}),
      ...(monthlyBudget !== undefined ? { monthlyBudget } : {}),
    };
  }
  const action = enumValue(input.action, "action", ["search", "watchlist", "plan_status", "manage_plan"] as const);
  const title = text(input.title, "title", 200);
  const genre = text(input.genre, "genre", 100);
  const profile = text(input.profile, "profile", 100);
  const planTier = text(input.planTier, "planTier", 100);
  return {
    ...(action ? { action } : {}),
    ...(title ? { title } : {}),
    ...(genre ? { genre } : {}),
    ...(profile ? { profile } : {}),
    ...(planTier ? { planTier } : {}),
  };
}

function customRetailer(name: string, origin: string, category: ShoppingCategory = "other"): ShoppingRetailer {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must be a clean HTTPS retailer origin");
  return { id: `custom-${url.hostname.toLowerCase()}`, name, origin: url.origin, countries: [], categories: [category], workflow: shoppingWorkflowFor({ categories: [category] }, category), supportsDelivery: false, supportsPickup: false };
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

function savedAsRetailer(site: ShoppingSite, preferredCategory?: ShoppingCategory): ShoppingRetailer {
  return { id: site.id, name: site.name, origin: site.origin, countries: [...site.countries], categories: [...site.categories], workflow: shoppingWorkflowFor(site, preferredCategory), supportsDelivery: site.supportsDelivery, supportsPickup: site.supportsPickup };
}

function detailValue(run: ShoppingRun, key: string): unknown {
  return run.details && typeof run.details === "object" ? (run.details as Record<string, unknown>)[key] : undefined;
}

function questions(run: ShoppingRun): string[] {
  const result: string[] = [];
  if (["flights", "stays", "telecom", "streaming"].includes(run.category)) {
    if (run.category === "flights") {
      const missing = [!detailValue(run, "origin") && "origin airport or city", !detailValue(run, "destination") && "destination airport or city", !detailValue(run, "departureDate") && "departure date", !detailValue(run, "passengers") && "passenger count"].filter(Boolean);
      if (missing.length) result.push(`What ${missing.join(", ")} should I use for the flight search?`);
    } else if (run.category === "stays") {
      const missing = [!detailValue(run, "location") && "location", !detailValue(run, "checkIn") && "check-in date", !detailValue(run, "checkOut") && "check-out date", !detailValue(run, "guests") && "guest count"].filter(Boolean);
      if (missing.length) result.push(`What ${missing.join(", ")} should I use for the stay search?`);
    } else if (run.category === "telecom") {
      if (!detailValue(run, "serviceType")) result.push("Do you need mobile service, home internet, or a bundle?");
    } else if (!detailValue(run, "action")) {
      result.push("Should I search titles, manage a watchlist, check the plan, or review plan options?");
    }
    if (!run.retailer) result.push("Which provider should I use, or should I compare suitable providers?");
    return result;
  }
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
      ? run.retailer.workflow === "reservation"
        ? "Use CHUCK_BROWSER to search restaurants, dates, times, party size, and availability publicly first. Verify the selected reservation details before asking for approval to confirm it."
        : run.retailer.workflow === "meal_plan"
          ? "Use CHUCK_BROWSER to inspect meal plans, dietary preferences, servings, delivery dates, and menu choices. Verify the plan summary before asking for approval to subscribe or place the order."
          : run.retailer.workflow === "flight_search"
            ? "Use CHUCK_BROWSER to search and compare flights, dates, passengers, cabin, bags, seats, and fare rules. Verify the itinerary and total at booking review; booking, payment, and final confirmation require approval."
            : run.retailer.workflow === "stay_search"
              ? "Use CHUCK_BROWSER to search and compare stays by location, dates, guests, rooms, property type, cancellation rules, and total. Verify the reservation review; booking, payment, and final confirmation require approval."
              : run.retailer.workflow === "service_plan"
                ? "Use CHUCK_BROWSER to compare public telecom plans, coverage, data, lines, devices, and monthly pricing. Use the vault only when account access is required; plan changes, upgrades, cancellations, and purchases require approval."
                : run.retailer.workflow === "streaming_account"
                  ? "Use CHUCK_BROWSER to search titles, inspect profiles and watchlists, and review plan status. Plan changes, upgrades, cancellations, and payment actions require approval."
                  : "Use CHUCK_BROWSER to browse the retailer publicly first: search, compare, and inspect product pages. Ask only for missing variant details when a candidate requires them. Use CHUCK_VAULT_LOGIN or CHUCK_VAULT_SAVE only if the live site requires authentication for the next step; then continue in the same retained browser."
      : "Ask the user to choose a retailer from the suggestions or name another HTTPS retailer. Do not ask for login credentials in chat.",
  };
}

export async function startShopping(userId: number, args: Record<string, unknown>) {
  const requestedCategory = category(args.category);
  const requestedRetailer = text(args.retailer, "retailer", 120);
  const knownRetailer = requestedRetailer ? getRetailer(requestedRetailer, requestedCategory) : undefined;
  const run = await createShoppingRun(userId, {
    id: `shop_${randomUUID()}`,
    items: items(args.items),
    category: requestedCategory,
    status: knownRetailer ? "ready_to_shop" : "awaiting_retailer",
    retailer: knownRetailer,
    country: country(args.country),
    city: text(args.city, "city", 120),
    postcode: text(args.postcode, "postcode", 32),
    budget: money(args.budget),
    currency: currency(args.currency),
    deliveryPreference: delivery(args.deliveryPreference),
    notes: text(args.notes, "notes", 1000),
    details: details(args.details, requestedCategory),
  });
  return view(run);
}

export async function selectShoppingRetailer(userId: number, args: Record<string, unknown>) {
  const run = await getShoppingRun(userId, required(args.id, "id", 120));
  if (!run) throw new Error("Shopping plan not found or not owned by you");
  if (run.status === "cancelled" || run.status === "completed") throw new Error("This shopping plan is no longer active");
  const name = required(args.retailer, "retailer", 120);
  const registered = await findShoppingSite(userId, name);
  const retailer = registered ? savedAsRetailer(registered, run.category) : getRetailer(name, run.category) ?? (args.origin ? customRetailer(name, required(args.origin, "origin", 300), run.category) : undefined);
  if (!retailer) throw new Error("That retailer is not in the starter catalogue. Provide its clean HTTPS origin so Chusky can use it safely.");
  const updated = await updateShoppingRun(userId, run.id, { retailer, status: "ready_to_shop" });
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
  const nextCategory = args.category !== undefined ? category(args.category) : run.category;
  if (args.category !== undefined) patch.category = nextCategory;
  if (args.country !== undefined) patch.country = country(args.country);
  if (args.city !== undefined) patch.city = text(args.city, "city", 120);
  if (args.postcode !== undefined) patch.postcode = text(args.postcode, "postcode", 32);
  if (args.budget !== undefined) patch.budget = money(args.budget);
  if (args.currency !== undefined) patch.currency = currency(args.currency);
  if (args.deliveryPreference !== undefined) patch.deliveryPreference = delivery(args.deliveryPreference);
  if (args.notes !== undefined) patch.notes = text(args.notes, "notes", 1000);
  if (args.details !== undefined) patch.details = details(args.details, nextCategory);
  else if (nextCategory !== run.category) patch.details = undefined;
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
  return { ...view(updated!), message: "The shopping plan and the same E2B browser session are preserved. Send ‘continue’ after you finish the private website step." };
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
SHOPPING AND SERVICE ENGINE
- Treat this as a general browser workflow, never as Amazon-only logic. Start a private plan with CHUCK_SHOPPING_START when the user asks to buy, order, restock, find, compare, reserve, book, manage a telecom service, manage a streaming account, or add products to a cart/watchlist.
- Ask only for missing decision-critical details: delivery country/area, retailer when more than one fits, delivery versus pickup, and budget or substitutions when relevant. If the user has named a retailer, respect it; otherwise use the shopping suggestions and, when necessary, live web research to propose current local options.
- After a retailer is chosen, call CHUCK_SHOPPING_SELECT_RETAILER. A user-owned saved site may be selected by name; use CHUCK_SHOPPING_SAVE_SITE to remember a clean HTTPS origin for future plans. Use CHUCK_BROWSER to browse publicly first: search, compare, inspect product pages, and identify the required variant. Do not start vault setup merely because the retailer has an account flow. Use CHUCK_VAULT_LOGIN or CHUCK_VAULT_SAVE only when the live page requires authentication for the next step; never request a password in chat. Continue the same shopping plan and retained browser after authentication.
- Use browser vaultAction=browse or search for ordinary navigation, and vaultAction=add_to_cart for cart changes. Verify every browser interaction with a snapshot or find result. A cart total, delivery slot, substitution, checkout, or order is not complete until the page confirms it.
- Match the provider workflow to the request: product_cart uses search → variant → cart → checkout review; meal_plan uses plan → dietary/servings → menu → delivery summary; reservation uses restaurant → date/time → party size → availability → reservation review; flight_search uses route → dates → passengers/cabin → fares → bags/seats → booking review; stay_search uses location → dates → guests/rooms → property rules → reservation review; service_plan uses service type → coverage/data/lines → device or plan comparison → account review; streaming_account uses title/profile/watchlist or plan-status → review. Do not force travel, telecom, or streaming tasks through a product-cart recipe.
- For flights and stays, compare public options and verify the exact itinerary, dates, guests, cancellation rules, taxes, fees, and total before asking for approval. For telecom, verify the plan, line count, device, monthly recurring price, one-time charges, and contract terms. For streaming, verify the title/profile/watchlist or current plan state. The final booking, plan change, upgrade, cancellation, purchase, payment, or subscription confirmation is always approval-gated.
- In an authenticated owner-private interactive run, a clear direct request authorizes ordinary browsing and cart preparation. Checkout, payment, placing an order, changing an address, adding a payment method, and deletions retain their exact approval or blocked policy. Clarify genuinely missing transaction details, and never claim a purchase succeeded unless the retailer confirmation page proves it. Other run types follow their configured approval policy.
- If CAPTCHA, 2FA, age verification, or another user-only challenge appears, call CHUCK_SHOPPING_PAUSE and CHUCK_BROWSER_HANDOFF. Send the returned short-lived private browser link only in the user's direct conversation. The user completes the website challenge in the same retained browser and replies “continue”; then call CHUCK_BROWSER_HANDOFF_COMPLETE with the returned handoffId, inspect the same-origin page, call CHUCK_BROWSER_VERIFY with the required detectors, and only then call CHUCK_SHOPPING_RESUME. Do not expose credentials, cookies, or session URLs in a shared group.
- If the user asks to see the browser, check progress, or take a screenshot without asking for another action, call CHUCK_BROWSER with action=screenshot and stop. The screenshot is delivered through the active private channel; do not browse, click, or change the page beyond the explicit request.
`.trim();
