import twilio from "twilio";
import { config } from "../config.js";

export type TwilioNumberSummary = {
  /** Available-number search results do not have a resource SID until purchase. */
  sid?: string;
  phoneNumber: string;
  friendlyName?: string;
  locality?: string;
  region?: string;
  isoCountry?: string;
  /** Customer-facing monthly price calculated from the live provider price. */
  customerPriceCents?: number;
  capabilities: { voice: boolean; sms: boolean; mms: boolean; fax: boolean };
};

export type TwilioNumberPurchaseSummary = TwilioNumberSummary & {
  /** Stored server-side for margin and billing reconciliation. */
  providerCostCents: number;
};

export type TwilioNumberPricingPolicy = {
  standardPriceCents: number;
  providerCostThresholdCents: number;
  markupCents: number;
  priceCapCents: number;
};

export type TwilioNumberFeatures = {
  voice?: boolean;
  sms?: boolean;
  mms?: boolean;
  fax?: boolean;
};

export type TwilioNumberSearch = {
  countryCode: string;
  areaCode?: string;
  areaCodes?: string[];
  region?: string;
  locality?: string;
  postalCode?: string;
  contains?: string;
  limit?: number;
  features?: TwilioNumberFeatures;
};

export type TwilioNumberCountry = {
  code: string;
  callingCode: string;
  name: string;
  flag: string;
  regionLabel: string;
  regionPlaceholder: string;
};

/** Initial customer-facing inventory. Keep this allowlist deliberately small
 * until regulatory requirements and number availability have been verified for
 * each additional market. */
export const TWILIO_SUPPORTED_NUMBER_COUNTRIES: readonly TwilioNumberCountry[] = [
  { code: "US", callingCode: "+1", name: "United States", flag: "🇺🇸", regionLabel: "State", regionPlaceholder: "CA or New York" },
  { code: "CA", callingCode: "+1", name: "Canada", flag: "🇨🇦", regionLabel: "Province", regionPlaceholder: "ON or Toronto" },
  { code: "GB", callingCode: "+44", name: "United Kingdom", flag: "🇬🇧", regionLabel: "Region", regionPlaceholder: "London" },
  { code: "DE", callingCode: "+49", name: "Germany", flag: "🇩🇪", regionLabel: "Region", regionPlaceholder: "Berlin" },
  { code: "FR", callingCode: "+33", name: "France", flag: "🇫🇷", regionLabel: "Region", regionPlaceholder: "Paris" },
  { code: "BE", callingCode: "+32", name: "Belgium", flag: "🇧🇪", regionLabel: "Region", regionPlaceholder: "Brussels" },
  { code: "AT", callingCode: "+43", name: "Austria", flag: "🇦🇹", regionLabel: "Region", regionPlaceholder: "Vienna" },
  { code: "IE", callingCode: "+353", name: "Ireland", flag: "🇮🇪", regionLabel: "Region", regionPlaceholder: "Dublin" },
  { code: "NL", callingCode: "+31", name: "Netherlands", flag: "🇳🇱", regionLabel: "Region", regionPlaceholder: "Amsterdam" },
  { code: "PT", callingCode: "+351", name: "Portugal", flag: "🇵🇹", regionLabel: "Region", regionPlaceholder: "Lisbon" },
  { code: "NO", callingCode: "+47", name: "Norway", flag: "🇳🇴", regionLabel: "Region", regionPlaceholder: "Oslo" },
  { code: "DK", callingCode: "+45", name: "Denmark", flag: "🇩🇰", regionLabel: "Region", regionPlaceholder: "Copenhagen" },
];

export type TwilioNumberDependencies = {
  enabled: boolean;
  accountSid: string;
  authToken: string;
  webhookBaseUrl: string;
  /** SMS/MMS is enabled only when the tenant webhook adapter is running. */
  smsEnabled?: boolean;
};

const defaults = (): TwilioNumberDependencies => ({
  enabled: config.twilioNumberManagementEnabled,
  accountSid: config.twilioAccountSid,
  authToken: config.twilioAuthToken,
  webhookBaseUrl: config.twilioWebhookBaseUrl,
  smsEnabled: config.twilioSmsEnabled,
});

const pricingCache = new Map<string, { providerCostCents: number; expiresAt: number }>();
const PRICING_CACHE_TTL_MS = 5 * 60 * 1000;

function pricingPolicy(): TwilioNumberPricingPolicy {
  return {
    standardPriceCents: config.twilioManagedNumberPriceCents,
    providerCostThresholdCents: config.twilioManagedNumberPriceThresholdCents,
    markupCents: config.twilioManagedNumberMarkupCents,
    priceCapCents: config.twilioManagedNumberPriceCapCents,
  };
}

/** Calculate the customer price without ever allowing a result above the cap. */
export function customerPriceForProviderCost(providerCostCents: number, policy: TwilioNumberPricingPolicy = pricingPolicy()): number | undefined {
  if (!Number.isSafeInteger(providerCostCents) || providerCostCents < 0) throw new Error("providerCostCents must be a non-negative integer.");
  const customerPriceCents = providerCostCents <= policy.providerCostThresholdCents
    ? policy.standardPriceCents
    : providerCostCents + policy.markupCents;
  return customerPriceCents <= policy.priceCapCents ? customerPriceCents : undefined;
}

function cents(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  const result = Math.round(parsed * 100);
  return Number.isSafeInteger(result) ? result : undefined;
}

async function providerNumberPrice(country: string, options: TwilioNumberDependencies): Promise<number> {
  const cached = pricingCache.get(country);
  if (cached && cached.expiresAt > Date.now()) return cached.providerCostCents;
  const client = twilio(options.accountSid, options.authToken);
  const pricing = await client.pricing.v1.phoneNumbers.countries.get(country).fetch();
  const local = pricing.phoneNumberPrices?.find((item) => String(item.numberType).toLowerCase() === "local") ?? pricing.phoneNumberPrices?.[0];
  const providerCostCents = cents(local?.currentPrice ?? local?.basePrice);
  if (providerCostCents === undefined) throw new Error("Twilio did not return a monthly local-number price for this country.");
  pricingCache.set(country, { providerCostCents, expiresAt: Date.now() + PRICING_CACHE_TTL_MS });
  return providerCostCents;
}

async function priceForCountry(country: string, options: TwilioNumberDependencies): Promise<{ providerCostCents: number; customerPriceCents: number } | undefined> {
  const providerCostCents = await providerNumberPrice(country, options);
  const customerPriceCents = customerPriceForProviderCost(providerCostCents);
  return customerPriceCents === undefined ? undefined : { providerCostCents, customerPriceCents };
}

function validate(options: TwilioNumberDependencies): void {
  if (!options.enabled) throw new Error("Phone number management is disabled. Enable it after configuring billing and Twilio.");
  if (!options.accountSid || !options.authToken) throw new Error("Twilio account credentials are required for phone number management.");
  if (!/^https:\/\//i.test(options.webhookBaseUrl)) throw new Error("TWILIO_WEBHOOK_BASE_URL must be an HTTPS URL.");
}

function countryCode(value: unknown): string {
  const result = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(result)) throw new Error("countryCode must be a two-letter country code.");
  if (!TWILIO_SUPPORTED_NUMBER_COUNTRIES.some((country) => country.code === result)) throw new Error("That country is not available for number purchasing yet.");
  return result;
}

function boundedLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(30, Math.floor(parsed))) : 10;
}

function normalize(value: { sid?: string; phoneNumber: string; friendlyName?: string | null; locality?: string | null; region?: string | null; isoCountry?: string | null; capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean } }, customerPriceCents?: number): TwilioNumberSummary {
  return {
    ...(value.sid ? { sid: value.sid } : {}),
    phoneNumber: value.phoneNumber,
    ...(value.friendlyName ? { friendlyName: value.friendlyName } : {}),
    ...(value.locality ? { locality: value.locality } : {}),
    ...(value.region ? { region: value.region } : {}),
    ...(value.isoCountry ? { isoCountry: value.isoCountry } : {}),
    ...(customerPriceCents !== undefined ? { customerPriceCents } : {}),
    capabilities: {
      voice: value.capabilities?.voice !== false,
      sms: value.capabilities?.sms === true,
      mms: value.capabilities?.mms === true,
      fax: value.capabilities?.fax === true,
    },
  };
}

function requestedFeatures(input: TwilioNumberFeatures | undefined): Required<TwilioNumberFeatures> {
  const features = {
    voice: input?.voice !== false,
    sms: input?.sms === true,
    mms: input?.mms === true,
    fax: input?.fax === true,
  };
  if (!features.voice && !features.sms && !features.mms && !features.fax) throw new Error("At least one number capability is required.");
  return features;
}

/** Search Twilio's live local-number inventory without exposing provider credentials. */
export async function searchTwilioNumbers(input: TwilioNumberSearch, options: TwilioNumberDependencies = defaults()): Promise<TwilioNumberSummary[]> {
  validate(options);
  const country = countryCode(input.countryCode);
  const features = requestedFeatures(input.features);
  if ((features.sms || features.mms) && options.smsEnabled !== true) throw new Error("Messaging numbers are not enabled for this deployment.");
  // Twilio exposes fax-capable inventory, but Chusky does not yet have a
  // durable fax receive/send channel. Never advertise a number as fax-ready
  // until that transport is implemented end to end.
  if (features.fax) throw new Error("Fax numbers are not enabled for this deployment.");
  const requestedAreaCodes = [...new Set([
    ...(input.areaCodes ?? []),
    ...(input.areaCode ? [input.areaCode] : []),
  ].map((value) => String(value).trim()).filter(Boolean))];
  if (requestedAreaCodes.length > 5) throw new Error("You can search up to five area codes at a time.");
  if (requestedAreaCodes.some((value) => !/^\d{1,6}$/.test(value))) throw new Error("areaCodes must contain only digits.");
  const region = input.region?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const locality = input.locality?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const postalCode = input.postalCode?.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 20);
  const contains = input.contains?.trim();
  if (contains && contains.length > 20) throw new Error("contains is too long.");
  const pricing = await priceForCountry(country, options);
  // Fail closed: never display inventory when the provider price is unknown or
  // the computed customer price exceeds the configured customer ceiling.
  if (!pricing) return [];
  const client = twilio(options.accountSid, options.authToken);
  const limit = boundedLimit(input.limit);
  const searchAreaCodes = requestedAreaCodes.length ? requestedAreaCodes : [undefined];
  const perSearchLimit = Math.max(1, Math.ceil(limit / searchAreaCodes.length));
  const results = await Promise.all(searchAreaCodes.map((areaCode) => client.availablePhoneNumbers(country).local.list({
    voiceEnabled: features.voice,
    ...(features.sms ? { smsEnabled: true } : {}),
    ...(features.mms ? { mmsEnabled: true } : {}),
    ...(areaCode ? { areaCode: Number(areaCode) } : {}),
    ...(region ? { inRegion: region } : {}),
    ...(locality ? { inLocality: locality } : {}),
    ...(postalCode ? { inPostalCode: postalCode } : {}),
    ...(contains ? { contains } : {}),
    limit: perSearchLimit,
  })));
  const unique = new Map<string, TwilioNumberSummary>();
  for (const batch of results) for (const item of batch) {
    const normalized = normalize(item, pricing.customerPriceCents);
    if (!unique.has(normalized.phoneNumber)) unique.set(normalized.phoneNumber, normalized);
  }
  return [...unique.values()].slice(0, limit);
}

/** Purchase one number and point its inbound voice webhook at Chusky. */
export async function purchaseTwilioNumber(input: { phoneNumber: string; countryCode?: string; friendlyName?: string; features?: TwilioNumberFeatures }, options: TwilioNumberDependencies = defaults()): Promise<TwilioNumberPurchaseSummary> {
  validate(options);
  const features = requestedFeatures(input.features);
  if ((features.sms || features.mms) && options.smsEnabled !== true) throw new Error("Messaging numbers are not enabled for this deployment.");
  if (features.fax) throw new Error("Fax numbers are not enabled for this deployment.");
  if (!/^\+[1-9]\d{7,14}$/.test(input.phoneNumber)) throw new Error("phoneNumber must be a valid E.164 number.");
  if (!input.countryCode) throw new Error("countryCode is required for price verification.");
  const country = TWILIO_SUPPORTED_NUMBER_COUNTRIES.find((item) => item.code === String(input.countryCode).trim().toUpperCase());
  if (!country) throw new Error("That country is not available for number purchasing yet.");
  if (!input.phoneNumber.startsWith(country.callingCode)) throw new Error("The selected country does not match the phone number.");
  const pricing = await priceForCountry(country.code, options);
  if (!pricing) throw new Error("This number is not available within Chusky's monthly price limit.");
  const friendlyName = input.friendlyName?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const base = options.webhookBaseUrl.replace(/\/+$/, "");
  const client = twilio(options.accountSid, options.authToken);
  const item = await client.incomingPhoneNumbers.create({
    phoneNumber: input.phoneNumber,
    voiceUrl: `${base}/twilio/inbound`,
    voiceMethod: "POST",
    ...(features.sms || features.mms ? {
      smsUrl: `${base}/twilio/sms`,
      smsMethod: "POST",
      statusCallback: `${base}/twilio/sms/status`,
      statusCallbackMethod: "POST",
    } : {}),
    ...(friendlyName ? { friendlyName } : {}),
  });
  return { ...normalize(item, pricing.customerPriceCents), providerCostCents: pricing.providerCostCents };
}

/** Release a number purchased through Chusky. */
export async function releaseTwilioNumber(sid: string, options: TwilioNumberDependencies = defaults()): Promise<void> {
  validate(options);
  if (!/^PN[0-9a-f]{32}$/i.test(sid)) throw new Error("Invalid Twilio phone-number resource.");
  const client = twilio(options.accountSid, options.authToken);
  await client.incomingPhoneNumbers(sid).remove();
}

export function isTwilioNumberManagementConfigured(options: TwilioNumberDependencies = defaults()): boolean {
  try { validate(options); return true; } catch { return false; }
}

export function twilioNumberCatalog(): TwilioNumberCountry[] {
  return TWILIO_SUPPORTED_NUMBER_COUNTRIES.map((country) => ({ ...country }));
}

export function platformTwilioNumberDependencies(): TwilioNumberDependencies {
  return defaults();
}
