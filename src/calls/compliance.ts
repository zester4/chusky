export type EmergencyAddress = {
  name: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
};

export type VoiceComplianceRecord = {
  userId: number;
  emergencyAddress?: EmergencyAddress;
  emergencyAddressStatus: "not_configured" | "pending_verification" | "verified" | "rejected";
  regulatoryStatus: "not_configured" | "pending_verification" | "verified" | "rejected";
  regulatoryCountries: string[];
  recordingConsentRequired: boolean;
  optOutEnabled: boolean;
  retentionDays: 1 | 7 | 30;
  /** Optimistic-concurrency version. Provider verification workers must not
   * overwrite a newer owner policy update. */
  version: number;
  updatedAt: number;
};

function text(value: unknown, label: string, max: number): string {
  const result = typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!result || result.length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return result;
}

export function normalizeEmergencyAddress(value: unknown): EmergencyAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Emergency address is required.");
  const input = value as Record<string, unknown>;
  const countryCode = text(input.countryCode, "countryCode", 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error("countryCode must be a two-letter country code.");
  return {
    name: text(input.name, "name", 120),
    street: text(input.street, "street", 180),
    city: text(input.city, "city", 100),
    region: text(input.region, "region", 100),
    postalCode: text(input.postalCode, "postalCode", 40),
    countryCode,
  };
}

export function normalizeVoiceComplianceInput(userId: number, input: Record<string, unknown>, current?: VoiceComplianceRecord): VoiceComplianceRecord {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("userId is invalid.");
  const retentionDays = input.retentionDays === undefined ? current?.retentionDays ?? 30 : input.retentionDays;
  if (retentionDays !== 1 && retentionDays !== 7 && retentionDays !== 30) throw new Error("retentionDays must be 1, 7, or 30.");
  const countries = input.regulatoryCountries === undefined ? current?.regulatoryCountries ?? [] : input.regulatoryCountries;
  if (!Array.isArray(countries) || countries.some((country) => typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country))) throw new Error("regulatoryCountries must contain two-letter country codes.");
  const address = input.emergencyAddress === undefined ? current?.emergencyAddress : input.emergencyAddress === null ? undefined : normalizeEmergencyAddress(input.emergencyAddress);
  const normalizedCountries = [...new Set(countries.map((country) => country.toUpperCase()))].slice(0, 30);
  const sameAddress = JSON.stringify(address ?? undefined) === JSON.stringify(current?.emergencyAddress ?? undefined);
  const sameCountries = JSON.stringify(normalizedCountries) === JSON.stringify(current?.regulatoryCountries ?? []);
  const now = Date.now();
  return {
    userId,
    ...(address ? { emergencyAddress: address } : {}),
    // A save of privacy/retention settings must not invalidate a provider
    // verification. Changing the address or coverage does invalidate only the
    // affected verification and returns it to pending.
    emergencyAddressStatus: address ? (current && sameAddress ? current.emergencyAddressStatus : "pending_verification") : "not_configured",
    regulatoryStatus: normalizedCountries.length ? (current && sameCountries ? current.regulatoryStatus : "pending_verification") : "not_configured",
    regulatoryCountries: normalizedCountries,
    recordingConsentRequired: input.recordingConsentRequired === undefined ? current?.recordingConsentRequired ?? true : input.recordingConsentRequired === true,
    optOutEnabled: input.optOutEnabled === undefined ? current?.optOutEnabled ?? true : input.optOutEnabled !== false,
    retentionDays,
    version: (current?.version ?? 0) + 1,
    updatedAt: now,
  };
}

export function complianceReadiness(record?: VoiceComplianceRecord): "not_configured" | "pending_verification" | "verified" {
  if (!record || record.emergencyAddressStatus === "not_configured" || record.regulatoryStatus === "not_configured") return "not_configured";
  if (record.emergencyAddressStatus !== "verified" || record.regulatoryStatus !== "verified") return "pending_verification";
  return "verified";
}
