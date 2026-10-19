import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { config } from "../config.js";
import { getBuilderVoiceControls } from "../builderControl.js";
import { decryptCredential, encryptCredential } from "../vault/crypto.js";
import {
  appendTwilioBillingEntry,
  getVoiceInboundRoute,
  getTwilioNumberOwnership,
  getTwilioSubaccount,
  getTwilioSubaccountByUserId,
  listTwilioSubaccounts,
  listTwilioNumberOwnership,
  saveTwilioNumberOwnership,
  saveTwilioSubaccount,
  type TwilioBillingLedgerEntry,
  type TwilioNumberOwnershipRecord,
  type TwilioSubaccountRecord,
} from "../store.js";
import type { PhoneCallRecord, VoiceInboundRouteRecord } from "../store.js";
import { isTwilioNumberManagementConfigured, platformTwilioNumberDependencies, type TwilioNumberDependencies } from "./twilioNumbers.js";

type TwilioCredentials = { accountSid: string; authToken: string };

export type TwilioSubaccountView = Omit<TwilioSubaccountRecord, "encryptedCredentials" | "lastHealthError"> & {
  numberCount?: number;
  billing?: { currency: "USD"; activeNumberCount: number; customerPriceCents: number };
};

export type TwilioWebhookCredentials = { accountSid: string; authToken: string };

function assertParentCredentials(): void {
  if (!config.twilioAccountSid || !config.twilioAuthToken) throw new Error("Twilio parent credentials are not configured.");
}

function assertEncryptionKey(): string {
  if (!config.twilioSubaccountEncryptionKey) throw new Error("TWILIO_SUBACCOUNT_ENCRYPTION_KEY is not configured.");
  return config.twilioSubaccountEncryptionKey;
}

async function assertManagementEnabled(): Promise<void> {
  if (!(await getBuilderVoiceControls()).subaccountManagementEnabled) throw new Error("Tenant phone-number management is disabled.");
}

function cleanLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) : "";
  return label || fallback;
}

function credentials(record: TwilioSubaccountRecord): TwilioCredentials {
  const key = assertEncryptionKey();
  const value = decryptCredential<TwilioCredentials>(record.encryptedCredentials, key, "TWILIO_SUBACCOUNT_ENCRYPTION_KEY");
  if (!/^AC[0-9a-f]{32}$/i.test(value.accountSid) || !value.authToken) throw new Error("Stored Twilio subaccount credentials are invalid.");
  return value;
}

/** Resolve the account credential used to authenticate a callback. Managed
 * numbers are signed by their tenant subaccount; legacy routes use the
 * platform parent account. This helper never returns the encrypted record or
 * exposes the token outside the request boundary. */
export async function twilioWebhookCredentialsForRoute(route?: Pick<VoiceInboundRouteRecord, "twilioSubaccountId">): Promise<TwilioWebhookCredentials | undefined> {
  if (route?.twilioSubaccountId) {
    const record = await getTwilioSubaccount(route.twilioSubaccountId);
    if (!record) return undefined;
    try { return credentials(record); } catch { return undefined; }
  }
  if (!config.twilioAccountSid || !config.twilioAuthToken) return undefined;
  return { accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken };
}

export async function twilioWebhookCredentialsForCall(call?: Pick<PhoneCallRecord, "twilioSubaccountId">): Promise<TwilioWebhookCredentials | undefined> {
  return twilioWebhookCredentialsForRoute(call);
}

function dependenciesFor(record: TwilioSubaccountRecord, numberManagementEnabled: boolean): TwilioNumberDependencies {
  const value = credentials(record);
  if (record.status !== "active" || record.providerStatus === "suspended" || record.providerStatus === "closed") throw new Error("This workspace phone account is not active.");
  if (!/^https:\/\//i.test(config.twilioWebhookBaseUrl)) throw new Error("The voice webhook is not configured.");
  return {
    enabled: numberManagementEnabled,
    accountSid: value.accountSid,
    authToken: value.authToken,
    webhookBaseUrl: config.twilioWebhookBaseUrl,
    smsEnabled: config.twilioSmsEnabled,
  };
}

function view(record: TwilioSubaccountRecord, numberCount = 0): TwilioSubaccountView {
  const { encryptedCredentials: _credentials, lastHealthError: _lastHealthError, ...safe } = record;
  return { ...safe, numberCount, billing: { currency: "USD", activeNumberCount: numberCount, customerPriceCents: config.twilioManagedNumberPriceCents } };
}

/** The customer API uses this only as an availability gate. It does not
 * expose why a tenant is not provisioned. */
export async function tenantNumberDependencies(userId: number): Promise<TwilioNumberDependencies | undefined> {
  const controls = await getBuilderVoiceControls();
  if (!controls.subaccountManagementEnabled || !controls.numberManagementEnabled) return undefined;
  const record = await getTwilioSubaccountByUserId(userId);
  if (!record) return undefined;
  try { return dependenciesFor(record, controls.numberManagementEnabled); } catch { return undefined; }
}

/** Search is read-only and may use the parent inventory before a workspace has
 * purchased its first number. The customer must never need to know that a
 * child account exists. */
export async function customerNumberSearchDependencies(): Promise<TwilioNumberDependencies | undefined> {
  const controls = await getBuilderVoiceControls();
  if (!controls.subaccountManagementEnabled || !controls.numberManagementEnabled) return undefined;
  // The persisted Builder switch is the runtime gate once the control plane
  // is enabled. The environment flag remains the safe default when no saved
  // Builder state exists; it must not override an audited administrator
  // enablement after that state has been saved.
  const dependencies = { ...platformTwilioNumberDependencies(), enabled: true };
  return isTwilioNumberManagementConfigured(dependencies) ? dependencies : undefined;
}

/** Resolve the credentials and tenant account for a managed number's SMS/MMS
 * webhook or outbound reply. The route lookup is the ownership boundary; the
 * encrypted child token never leaves this server module. */
export async function twilioSmsCredentialsForNumber(phoneNumber: string): Promise<(TwilioWebhookCredentials & { twilioSubaccountId?: string }) | undefined> {
  const route = await getVoiceInboundRoute("twilio", phoneNumber);
  if (!route || route.capabilities?.sms === false) return undefined;
  const credentials = await twilioWebhookCredentialsForRoute(route);
  return credentials ? { ...credentials, ...(route?.twilioSubaccountId ? { twilioSubaccountId: route.twilioSubaccountId } : {}) } : undefined;
}

/** Provisioning is lazy: the first purchase creates the isolated Twilio
 * subaccount automatically, while Twilio still bills the platform parent. */
export async function ensureTenantNumberDependencies(userId: number, friendlyName?: unknown): Promise<{ dependencies: TwilioNumberDependencies; subaccount: TwilioSubaccountView }> {
  const subaccount = await provisionTwilioSubaccount(userId, friendlyName);
  const dependencies = await subaccountNumberDependencies(subaccount.id);
  return { dependencies, subaccount };
}

/** Existing legacy parent-account routes remain readable and releasable by
 * their old path; new inventory must always use an active tenant account. */
export async function subaccountNumberDependencies(id: string): Promise<TwilioNumberDependencies> {
  const controls = await getBuilderVoiceControls();
  if (!controls.subaccountManagementEnabled || !controls.numberManagementEnabled) throw new Error("Tenant phone-number management is disabled.");
  const record = await getTwilioSubaccount(id);
  if (!record) throw new Error("The workspace phone account was not found.");
  return dependenciesFor(record, controls.numberManagementEnabled);
}

export async function provisionTwilioSubaccount(userId: number, friendlyName?: unknown): Promise<TwilioSubaccountView> {
  await assertManagementEnabled();
  assertParentCredentials();
  const existing = await getTwilioSubaccountByUserId(userId);
  if (existing) return view(existing);
  const encryptionKey = assertEncryptionKey();
  const label = cleanLabel(friendlyName, `Chusky workspace ${userId}`);
  const parent = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const account = await parent.api.v2010.accounts.create({ friendlyName: label });
  const now = Date.now();
  const record: TwilioSubaccountRecord = {
    id: `twa_${randomUUID().replace(/-/g, "")}`,
    userId,
    twilioAccountSid: account.sid,
    encryptedCredentials: encryptCredential({ accountSid: account.sid, authToken: account.authToken }, encryptionKey, "TWILIO_SUBACCOUNT_ENCRYPTION_KEY"),
    status: account.status === "active" ? "active" : account.status === "suspended" ? "suspended" : "closed",
    friendlyName: label,
    providerStatus: account.status,
    createdAt: now,
    updatedAt: now,
  };
  if (!(await saveTwilioSubaccount(record))) {
    // A concurrent admin request won the tenant slot. Close the just-created
    // provider account rather than leaving an unowned billable resource.
    try { await parent.api.v2010.accounts(account.sid).update({ status: "closed" }); } catch { /* best-effort compensation */ }
    const concurrent = await getTwilioSubaccountByUserId(userId);
    if (concurrent) return view(concurrent);
    throw new Error("The workspace phone account could not be saved safely.");
  }
  await appendTwilioBillingEntry({ id: `twb_${randomUUID().replace(/-/g, "")}`, userId, subaccountId: record.id, kind: "subaccount_provisioning", amountCents: 0, currency: "USD", status: "recorded", createdAt: now });
  return view(record);
}

export async function updateTwilioSubaccountStatus(id: string, status: "active" | "suspended"): Promise<TwilioSubaccountView> {
  await assertManagementEnabled();
  assertParentCredentials();
  const record = await getTwilioSubaccount(id);
  if (!record) throw new Error("The workspace phone account was not found.");
  const parent = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const account = await parent.api.v2010.accounts(record.twilioAccountSid).update({ status });
  const now = Date.now();
  const next: TwilioSubaccountRecord = { ...record, status: account.status === "active" ? "active" : account.status === "suspended" ? "suspended" : "closed", providerStatus: account.status, suspendedAt: status === "suspended" ? now : record.suspendedAt, updatedAt: now };
  if (!(await saveTwilioSubaccount(next))) throw new Error("The workspace phone account changed while it was being updated.");
  return view(next);
}

export async function checkTwilioSubaccountHealth(id: string): Promise<TwilioSubaccountView> {
  await assertManagementEnabled();
  assertParentCredentials();
  const record = await getTwilioSubaccount(id);
  if (!record) throw new Error("The workspace phone account was not found.");
  const now = Date.now();
  try {
    const parent = twilio(config.twilioAccountSid, config.twilioAuthToken);
    const account = await parent.api.v2010.accounts(record.twilioAccountSid).fetch();
    const tenant = twilio(record.twilioAccountSid, credentials(record).authToken);
    await tenant.incomingPhoneNumbers.list({ limit: 1 });
    const next: TwilioSubaccountRecord = { ...record, providerStatus: account.status, status: account.status === "active" ? "active" : account.status === "suspended" ? "suspended" : "closed", lastHealthCheckAt: now, lastHealthStatus: "healthy", lastHealthError: undefined, lastHealthErrorCode: undefined, updatedAt: now };
    await saveTwilioSubaccount(next);
    return view(next);
  } catch (error) {
    const next: TwilioSubaccountRecord = { ...record, lastHealthCheckAt: now, lastHealthStatus: "unhealthy", lastHealthErrorCode: "provider_unreachable", lastHealthError: error instanceof Error ? error.message.slice(0, 240) : "Provider health check failed", updatedAt: now };
    await saveTwilioSubaccount(next);
    return view(next);
  }
}

export async function listTwilioSubaccountViews(limit = 100): Promise<TwilioSubaccountView[]> {
  const records = await listTwilioSubaccounts(limit);
  return Promise.all(records.map(async (record) => {
    const ownership = await listTwilioNumberOwnership(record.userId, 500);
    return view(record, ownership.filter((item) => item.status === "active").length);
  }));
}

export function ownershipRecord(input: { userId: number; subaccountId: string; phoneNumber: string; providerNumberId: string }): TwilioNumberOwnershipRecord {
  const now = Date.now();
  return { id: `two_${randomUUID().replace(/-/g, "")}`, ...input, status: "active", currency: "USD", customerPriceCents: config.twilioManagedNumberPriceCents, purchasedAt: now, updatedAt: now };
}

export async function savePurchasedNumberOwnership(record: TwilioNumberOwnershipRecord): Promise<void> {
  if (!(await saveTwilioNumberOwnership(record))) throw new Error("That phone number ownership record already belongs to another workspace.");
  const entry: TwilioBillingLedgerEntry = { id: `twb_${randomUUID().replace(/-/g, "")}`, userId: record.userId, subaccountId: record.subaccountId, ownershipId: record.id, kind: "number_purchase", amountCents: record.customerPriceCents ?? 0, currency: record.currency, status: "recorded", createdAt: Date.now(), metadata: { phoneNumber: record.phoneNumber } };
  await appendTwilioBillingEntry(entry);
}

export async function markNumberOwnershipReleased(providerNumberId: string, userId: number): Promise<boolean> {
  const current = await getTwilioNumberOwnership(providerNumberId);
  if (!current || current.userId !== userId || current.status === "released") return false;
  const now = Date.now();
  const next: TwilioNumberOwnershipRecord = { ...current, status: "released", releasedAt: now, updatedAt: now };
  if (!(await saveTwilioNumberOwnership(next))) return false;
  await appendTwilioBillingEntry({ id: `twb_${randomUUID().replace(/-/g, "")}`, userId, subaccountId: current.subaccountId, ownershipId: current.id, kind: "number_release", amountCents: 0, currency: current.currency, status: "recorded", createdAt: now, metadata: { phoneNumber: current.phoneNumber } });
  return true;
}

