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
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
};

export type TwilioNumberSearch = {
  countryCode: string;
  areaCode?: string;
  region?: string;
  locality?: string;
  postalCode?: string;
  contains?: string;
  limit?: number;
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
  { code: "IE", callingCode: "+353", name: "Ireland", flag: "🇮🇪", regionLabel: "Region", regionPlaceholder: "Dublin" },
  { code: "NL", callingCode: "+31", name: "Netherlands", flag: "🇳🇱", regionLabel: "Region", regionPlaceholder: "Amsterdam" },
  { code: "ES", callingCode: "+34", name: "Spain", flag: "🇪🇸", regionLabel: "Region", regionPlaceholder: "Madrid" },
  { code: "IT", callingCode: "+39", name: "Italy", flag: "🇮🇹", regionLabel: "Region", regionPlaceholder: "Rome" },
  { code: "SE", callingCode: "+46", name: "Sweden", flag: "🇸🇪", regionLabel: "Region", regionPlaceholder: "Stockholm" },
  { code: "NO", callingCode: "+47", name: "Norway", flag: "🇳🇴", regionLabel: "Region", regionPlaceholder: "Oslo" },
  { code: "DK", callingCode: "+45", name: "Denmark", flag: "🇩🇰", regionLabel: "Region", regionPlaceholder: "Copenhagen" },
];

export type TwilioNumberDependencies = {
  enabled: boolean;
  accountSid: string;
  authToken: string;
  webhookBaseUrl: string;
};

const defaults = (): TwilioNumberDependencies => ({
  enabled: config.twilioNumberManagementEnabled,
  accountSid: config.twilioAccountSid,
  authToken: config.twilioAuthToken,
  webhookBaseUrl: config.twilioWebhookBaseUrl,
});

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

function normalize(value: { sid?: string; phoneNumber: string; friendlyName?: string | null; locality?: string | null; region?: string | null; isoCountry?: string | null; capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean } }): TwilioNumberSummary {
  return {
    ...(value.sid ? { sid: value.sid } : {}),
    phoneNumber: value.phoneNumber,
    ...(value.friendlyName ? { friendlyName: value.friendlyName } : {}),
    ...(value.locality ? { locality: value.locality } : {}),
    ...(value.region ? { region: value.region } : {}),
    ...(value.isoCountry ? { isoCountry: value.isoCountry } : {}),
    capabilities: {
      voice: value.capabilities?.voice !== false,
      sms: value.capabilities?.sms === true,
      mms: value.capabilities?.mms === true,
    },
  };
}

/** Search voice-capable local numbers without exposing Twilio to the client. */
export async function searchTwilioNumbers(input: TwilioNumberSearch, options: TwilioNumberDependencies = defaults()): Promise<TwilioNumberSummary[]> {
  validate(options);
  const country = countryCode(input.countryCode);
  const areaCode = input.areaCode?.trim();
  if (areaCode && !/^\d{1,6}$/.test(areaCode)) throw new Error("areaCode must contain only digits.");
  const areaCodeNumber = areaCode ? Number(areaCode) : undefined;
  const region = input.region?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const locality = input.locality?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const postalCode = input.postalCode?.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 20);
  const contains = input.contains?.trim();
  if (contains && contains.length > 20) throw new Error("contains is too long.");
  const client = twilio(options.accountSid, options.authToken);
  const results = await client.availablePhoneNumbers(country).local.list({
    voiceEnabled: true,
    ...(areaCodeNumber === undefined ? {} : { areaCode: areaCodeNumber }),
    ...(region ? { inRegion: region } : {}),
    ...(locality ? { inLocality: locality } : {}),
    ...(postalCode ? { inPostalCode: postalCode } : {}),
    ...(contains ? { contains } : {}),
    limit: boundedLimit(input.limit),
  });
  return results.map((item) => normalize(item));
}

/** Purchase one number and point its inbound voice webhook at Chusky. */
export async function purchaseTwilioNumber(input: { phoneNumber: string; countryCode?: string; friendlyName?: string }, options: TwilioNumberDependencies = defaults()): Promise<TwilioNumberSummary> {
  validate(options);
  if (!/^\+[1-9]\d{7,14}$/.test(input.phoneNumber)) throw new Error("phoneNumber must be a valid E.164 number.");
  if (input.countryCode) {
    const country = TWILIO_SUPPORTED_NUMBER_COUNTRIES.find((item) => item.code === String(input.countryCode).trim().toUpperCase());
    if (!country) throw new Error("That country is not available for number purchasing yet.");
    if (!input.phoneNumber.startsWith(country.callingCode)) throw new Error("The selected country does not match the phone number.");
  }
  const friendlyName = input.friendlyName?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const base = options.webhookBaseUrl.replace(/\/+$/, "");
  const client = twilio(options.accountSid, options.authToken);
  const item = await client.incomingPhoneNumbers.create({
    phoneNumber: input.phoneNumber,
    voiceUrl: `${base}/twilio/inbound`,
    voiceMethod: "POST",
    ...(friendlyName ? { friendlyName } : {}),
  });
  return normalize(item);
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
