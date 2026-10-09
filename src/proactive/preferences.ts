import { configureAttentionPulse, type NativeToolRuntime } from "../nativeTools.js";
import { createAttentionRecord, listAttentionRecords, listChannelIdentities, updateAttentionRecord, type AutonomyProfileRecord, type DeliveryPreferenceRecord } from "../store.js";
import type { ChannelProvider } from "../channels/contracts.js";
import { classifyPulseHealth, type PulseHealth, type PulseHealthOccurrence } from "./pulseHealth.js";

export type PulseCadence = "every_30_minutes" | "hourly" | "daily";
export type PulseAuthority = "observe" | "prepare" | "execute_reversible";

export interface PulseDeliveryTarget {
  provider: ChannelProvider;
  conversationId?: string;
}

export interface PulsePreferencesInput {
  enabled: boolean;
  cadence?: PulseCadence;
  authority?: PulseAuthority;
  deliveryTargets?: PulseDeliveryTarget[];
  maxPerDay?: number;
  quietHoursUtc?: { startMinute: number; endMinute: number } | null;
  monitoredDomains?: string[];
}

export interface PulsePreferencesView {
  enabled: boolean;
  cadence: PulseCadence;
  authority: PulseAuthority;
  deliveryTargets: Array<Pick<DeliveryPreferenceRecord, "id" | "provider" | "conversationId" | "enabled" | "mode" | "quietHoursUtc" | "maxPerDay" | "minScore" | "createdAt" | "updatedAt">>;
  maxPerDay: number;
  quietHoursUtc?: { startMinute: number; endMinute: number };
  monitoredDomains: string[];
  health: PulseHealth;
}

const CADENCE_CRON: Record<PulseCadence, string> = {
  every_30_minutes: "*/30 * * * *",
  hourly: "0 * * * *",
  daily: "0 9 * * *",
};
const DEFAULT_DOMAINS = ["gmail", "calendar"];
const PROVIDERS = new Set<ChannelProvider>(["telegram", "slack", "whatsapp", "sendblue", "sms", "x", "xchat", "voice", "cli", "webhook"]);

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalizeQuietHours(value: PulsePreferencesInput["quietHoursUtc"]): { startMinute: number; endMinute: number } | undefined {
  if (value === null || value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("quietHoursUtc must contain startMinute and endMinute");
  const startMinute = boundedInteger(value.startMinute, -1, 0, 1439);
  const endMinute = boundedInteger(value.endMinute, -1, 0, 1439);
  if (startMinute < 0 || endMinute < 0) throw new Error("quietHoursUtc minutes must be whole numbers from 0 to 1439");
  return { startMinute, endMinute };
}

function normalizeTargets(value: PulsePreferencesInput["deliveryTargets"]): PulseDeliveryTarget[] {
  if (!value) return [{ provider: "telegram" }];
  if (!Array.isArray(value) || value.length > 8) throw new Error("deliveryTargets must contain at most eight channels");
  const seen = new Set<string>();
  return value.flatMap((target) => {
    if (!target || typeof target !== "object" || !PROVIDERS.has(target.provider)) throw new Error("Each delivery target must use a supported channel provider");
    if (target.conversationId !== undefined && typeof target.conversationId !== "string") throw new Error("conversationId must be a string");
    const conversationId = target.conversationId?.trim();
    if (conversationId && conversationId.length > 300) throw new Error("conversationId is too long");
    const key = `${target.provider}:${conversationId ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ provider: target.provider, ...(conversationId ? { conversationId } : {}) }];
  });
}

function normalizeDomains(value: PulsePreferencesInput["monitoredDomains"]): string[] {
  if (!value) return [...DEFAULT_DOMAINS];
  if (!Array.isArray(value) || value.length > 30) throw new Error("monitoredDomains must contain at most thirty app domains");
  const domains = [...new Set(value.flatMap((domain) => typeof domain === "string" ? domain.trim().toLowerCase() : []))];
  if (domains.some((domain) => !/^[a-z][a-z0-9_-]{1,79}$/.test(domain))) throw new Error("monitoredDomains contains an invalid app domain");
  return domains;
}

export function normalizePulsePreferences(input: PulsePreferencesInput): Required<Pick<PulsePreferencesInput, "enabled" | "cadence" | "authority" | "maxPerDay" | "deliveryTargets" | "monitoredDomains">> & { quietHoursUtc?: { startMinute: number; endMinute: number } } {
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const cadence = input.cadence ?? "hourly";
  if (!(cadence in CADENCE_CRON)) throw new Error("cadence must be every_30_minutes, hourly, or daily");
  const authority = input.authority ?? "prepare";
  if (!["observe", "prepare", "execute_reversible"].includes(authority)) throw new Error("authority is invalid");
  return {
    enabled: input.enabled,
    cadence,
    authority,
    maxPerDay: boundedInteger(input.maxPerDay, 4, 0, 1000),
    deliveryTargets: normalizeTargets(input.deliveryTargets),
    monitoredDomains: normalizeDomains(input.monitoredDomains),
    ...(normalizeQuietHours(input.quietHoursUtc) ? { quietHoursUtc: normalizeQuietHours(input.quietHoursUtc) } : {}),
  } as Required<Pick<PulsePreferencesInput, "enabled" | "cadence" | "authority" | "maxPerDay" | "deliveryTargets" | "monitoredDomains">> & { quietHoursUtc?: { startMinute: number; endMinute: number } };
}

async function upsertProfile(userId: number, values: { enabled: boolean; authority: PulseAuthority; quietHoursUtc?: { startMinute: number; endMinute: number }; monitoredDomains: string[]; maxPerDay: number }): Promise<AutonomyProfileRecord> {
  const profiles = await listAttentionRecords(userId, "autonomy_profile", { limit: 20 }) as AutonomyProfileRecord[];
  const current = profiles.find((profile) => profile.mode === "personal");
  const patch = { mode: "personal", enabled: values.enabled, defaultAuthority: values.authority, maxChecksPerDay: 24, maxAutonomousActionsPerDay: values.maxPerDay, notifyOn: "important", allowedDomains: values.monitoredDomains, deniedDomains: [], ...(values.quietHoursUtc ? { quietHoursUtc: values.quietHoursUtc } : { quietHoursUtc: undefined }) };
  return current ? await updateAttentionRecord(userId, "autonomy_profile", current.id, patch) as AutonomyProfileRecord : await createAttentionRecord(userId, "autonomy_profile", patch) as AutonomyProfileRecord;
}

async function upsertDeliveryPreferences(userId: number, preferences: ReturnType<typeof normalizePulsePreferences>): Promise<DeliveryPreferenceRecord[]> {
  const linkedChannels = await listChannelIdentities(userId);
  for (const target of preferences.deliveryTargets) {
    if (target.provider === "telegram") continue;
    if (!target.conversationId || !linkedChannels.some((identity) => identity.userId === userId && identity.provider === target.provider && identity.externalUserId === target.conversationId && !identity.disabledAt && identity.proactiveOptIn !== false)) {
      throw new Error(`The selected ${target.provider === "sendblue" ? "iMessage" : target.provider} channel is not linked and opted in for this account.`);
    }
  }
  const existing = await listAttentionRecords(userId, "delivery_preference", { limit: 100 }) as DeliveryPreferenceRecord[];
  const selected = new Set(preferences.deliveryTargets.map((target) => `${target.provider}:${target.conversationId ?? ""}`));
  for (const preference of existing) {
    const key = `${preference.provider}:${preference.conversationId ?? ""}`;
    if (!selected.has(key) && preference.enabled) await updateAttentionRecord(userId, "delivery_preference", preference.id, { enabled: false });
  }
  for (const target of preferences.deliveryTargets) {
    const current = existing.find((item) => item.provider === target.provider && item.conversationId === target.conversationId);
    const patch = { provider: target.provider, ...(target.conversationId ? { conversationId: target.conversationId } : {}), enabled: preferences.enabled, mode: preferences.enabled ? "immediate" : "silent", maxPerDay: preferences.maxPerDay, ...(preferences.quietHoursUtc ? { quietHoursUtc: preferences.quietHoursUtc } : { quietHoursUtc: undefined }) };
    if (current) await updateAttentionRecord(userId, "delivery_preference", current.id, patch);
    else await createAttentionRecord(userId, "delivery_preference", patch);
  }
  return await listAttentionRecords(userId, "delivery_preference", { limit: 100 }) as DeliveryPreferenceRecord[];
}

function cronForCadence(cadence: PulseCadence): string {
  return cadence === "every_30_minutes" ? "*/30 * * * *" : cadence === "daily" ? "0 9 * * *" : "0 * * * *";
}

function cadenceForCron(cron: unknown): PulseCadence {
  return cron === "*/30 * * * *" ? "every_30_minutes" : cron === "0 9 * * *" ? "daily" : "hourly";
}

async function restorePreferenceState(userId: number, beforeProfiles: AutonomyProfileRecord[], beforeDelivery: DeliveryPreferenceRecord[]): Promise<void> {
  const currentProfiles = await listAttentionRecords(userId, "autonomy_profile", { limit: 20 }) as AutonomyProfileRecord[];
  const currentProfile = currentProfiles.find((item) => item.mode === "personal");
  const previousProfile = beforeProfiles.find((item) => item.mode === "personal");
  if (currentProfile && previousProfile) {
    await updateAttentionRecord(userId, "autonomy_profile", currentProfile.id, {
      enabled: previousProfile.enabled, defaultAuthority: previousProfile.defaultAuthority, quietHoursUtc: previousProfile.quietHoursUtc,
      maxChecksPerDay: previousProfile.maxChecksPerDay, maxAutonomousActionsPerDay: previousProfile.maxAutonomousActionsPerDay,
      notifyOn: previousProfile.notifyOn, allowedDomains: previousProfile.allowedDomains, deniedDomains: previousProfile.deniedDomains,
    });
  } else if (currentProfile && !previousProfile) {
    await updateAttentionRecord(userId, "autonomy_profile", currentProfile.id, { enabled: false });
  }
  const currentDelivery = await listAttentionRecords(userId, "delivery_preference", { limit: 100 }) as DeliveryPreferenceRecord[];
  const previousKeys = new Set(beforeDelivery.map((item) => `${item.provider}:${item.conversationId ?? ""}`));
  for (const current of currentDelivery) {
    const key = `${current.provider}:${current.conversationId ?? ""}`;
    if (!previousKeys.has(key)) await updateAttentionRecord(userId, "delivery_preference", current.id, { enabled: false, mode: "silent" });
  }
  for (const previous of beforeDelivery) {
    const current = currentDelivery.find((item) => item.provider === previous.provider && item.conversationId === previous.conversationId);
    const patch = { enabled: previous.enabled, mode: previous.mode, maxPerDay: previous.maxPerDay, minScore: previous.minScore, quietHoursUtc: previous.quietHoursUtc };
    if (current) await updateAttentionRecord(userId, "delivery_preference", current.id, patch);
    else await createAttentionRecord(userId, "delivery_preference", { provider: previous.provider, ...(previous.conversationId ? { conversationId: previous.conversationId } : {}), ...patch });
  }
}

function deliveryPreferenceView(preferences: DeliveryPreferenceRecord[]): PulsePreferencesView["deliveryTargets"] {
  return preferences.map(({ id, provider, conversationId, enabled, mode, quietHoursUtc, maxPerDay, minScore, createdAt, updatedAt }) => ({
    id, provider, ...(conversationId ? { conversationId } : {}), enabled, mode,
    ...(quietHoursUtc ? { quietHoursUtc } : {}), ...(maxPerDay === undefined ? {} : { maxPerDay }), ...(minScore === undefined ? {} : { minScore }), createdAt, updatedAt,
  }));
}

export async function applyPulsePreferences(userId: number, input: PulsePreferencesInput, runtime: NativeToolRuntime = {}): Promise<PulsePreferencesView> {
  const preferences = normalizePulsePreferences(input);
  const beforeStatus = await configureAttentionPulse(userId, { action: "status" }) as { enabled?: boolean; jobs?: Array<{ cron?: string }> };
  const beforeProfiles = await listAttentionRecords(userId, "autonomy_profile", { limit: 20 }) as AutonomyProfileRecord[];
  const beforeDelivery = await listAttentionRecords(userId, "delivery_preference", { limit: 100 }) as DeliveryPreferenceRecord[];
  try {
    if (preferences.enabled) await configureAttentionPulse(userId, { action: "enable", cron: cronForCadence(preferences.cadence) }, runtime);
    else await configureAttentionPulse(userId, { action: "disable" }, runtime);
    await upsertProfile(userId, { enabled: preferences.enabled, authority: preferences.authority, quietHoursUtc: preferences.quietHoursUtc, monitoredDomains: preferences.monitoredDomains, maxPerDay: preferences.maxPerDay });
    await upsertDeliveryPreferences(userId, preferences);
    return await readPulsePreferences(userId);
  } catch (error) {
    try {
      if (beforeStatus.enabled) await configureAttentionPulse(userId, { action: "enable", cron: beforeStatus.jobs?.[0]?.cron ?? cronForCadence("hourly") }, runtime);
      else await configureAttentionPulse(userId, { action: "disable" }, runtime);
      await restorePreferenceState(userId, beforeProfiles, beforeDelivery);
    } catch (rollbackError) {
      throw new Error("Attention Pulse update failed and its previous state could not be fully restored. Inspect Pulse status before retrying.", { cause: rollbackError });
    }
    throw error;
  }
}

export async function readPulsePreferences(userId: number): Promise<PulsePreferencesView> {
  const profiles = await listAttentionRecords(userId, "autonomy_profile", { limit: 20 }) as AutonomyProfileRecord[];
  const profile = profiles.find((item) => item.mode === "personal");
  const deliveryTargets = await listAttentionRecords(userId, "delivery_preference", { limit: 100 }) as DeliveryPreferenceRecord[];
  const status = await configureAttentionPulse(userId, { action: "status" }) as {
    enabled?: boolean;
    jobs?: Array<{ cron?: string; status?: "active" | "paused" | "cancelled"; scheduleError?: string }>;
    connectedAccountsVerified?: boolean;
    capabilitySuggestions?: Array<{ status?: string }>;
    health?: { lastOccurrence?: PulseHealthOccurrence };
    watchCoverage?: { active?: number; current?: number; scheduled?: number; stale?: number; failed?: number; neverChecked?: number };
  };
  const job = status;
  const cron = job.jobs?.[0]?.cron;
  const cadence = cadenceForCron(cron);
  const coverage = status.watchCoverage ?? {};
  const health = classifyPulseHealth({
    enabled: Boolean(job.enabled),
    cadence,
    jobStatus: job.jobs?.[0]?.status,
    scheduleError: job.jobs?.[0]?.scheduleError,
    latestOccurrence: status.health?.lastOccurrence,
    activeWatches: coverage.active ?? 0,
    currentWatches: coverage.current ?? 0,
    scheduledWatches: coverage.scheduled ?? 0,
    staleWatches: coverage.stale ?? 0,
    failedWatches: coverage.failed ?? 0,
    neverCheckedWatches: coverage.neverChecked ?? 0,
    pendingSuggestions: status.capabilitySuggestions?.filter((candidate) => candidate.status === "pending").length ?? 0,
    connectedAccountsVerified: status.connectedAccountsVerified === true,
  });
  return { enabled: Boolean(job.enabled), cadence, authority: profile?.defaultAuthority ?? "observe", deliveryTargets: deliveryPreferenceView(deliveryTargets), maxPerDay: deliveryTargets.find((item) => item.enabled)?.maxPerDay ?? profile?.maxAutonomousActionsPerDay ?? 4, ...(profile?.quietHoursUtc ? { quietHoursUtc: profile.quietHoursUtc } : {}), monitoredDomains: profile?.allowedDomains?.length ? profile.allowedDomains : [...DEFAULT_DOMAINS], health };
}
