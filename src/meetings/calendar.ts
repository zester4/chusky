import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

export type CalendarMeetingLifecycle = "created" | "updated" | "sync" | "starting_soon" | "attendee_response" | "cancelled";

export interface CalendarMeetingCandidate {
  lifecycle: CalendarMeetingLifecycle;
  calendarEventId?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  participants: string[];
  meetingUrl?: string;
}

const CALENDAR_TRIGGER_LIFECYCLES: Record<string, CalendarMeetingLifecycle> = {
  GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER: "created",
  GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER: "updated",
  GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER: "updated",
  GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER: "sync",
  GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER: "starting_soon",
  GOOGLECALENDAR_ATTENDEE_RESPONSE_CHANGED_TRIGGER: "attendee_response",
  GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER: "cancelled",
};

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return normalized || undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstText(source: Record<string, unknown>[], keys: string[], maximum: number): string | undefined {
  for (const item of source) for (const key of keys) {
    const value = text(item[key], maximum);
    if (value) return value;
  }
  return undefined;
}

function firstNestedText(source: Record<string, unknown>[], keys: string[], maximum: number): string | undefined {
  for (const item of source) for (const key of keys) {
    const nested = record(item[key]);
    const value = nested && firstText([nested], ["dateTime", "date_time", "date", "value"], maximum);
    if (value) return value;
  }
  return undefined;
}

function supportedMeetingUrl(value: unknown): string | undefined {
  const url = text(value, 2_048);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "meet.google.com" || hostname.endsWith(".zoom.us") || hostname === "teams.microsoft.com" || hostname.endsWith(".teams.microsoft.com") || hostname.endsWith(".webex.com")) return parsed.toString();
  } catch { /* Not a usable URL. */ }
  return undefined;
}

function conferenceUrl(source: Record<string, unknown>[]): string | undefined {
  for (const item of source) {
    for (const key of ["hangoutLink", "hangout_link", "meetingUrl", "meeting_url", "conferenceLink", "conference_link", "htmlLink", "html_link"]) {
      const url = supportedMeetingUrl(item[key]);
      if (url) return url;
    }
    const conference = record(item.conferenceData) ?? record(item.conference_data);
    const entryPoints = conference?.entryPoints ?? conference?.entry_points;
    if (Array.isArray(entryPoints)) for (const entry of entryPoints) {
      const url = supportedMeetingUrl(record(entry)?.uri);
      if (url) return url;
    }
  }
  return undefined;
}

function participantNames(source: Record<string, unknown>[]): string[] {
  const values: string[] = [];
  for (const item of source) {
    const raw = item.attendees ?? item.participants ?? item.invitees;
    if (!Array.isArray(raw)) continue;
    for (const attendee of raw.slice(0, 30)) {
      const data = record(attendee);
      const name = data && (text(data.displayName, 120) ?? text(data.display_name, 120) ?? text(data.email, 160));
      if (name) values.push(name);
    }
    const organizer = record(item.organizer);
    const organizerName = organizer && (text(organizer.displayName, 120) ?? text(organizer.email, 160));
    if (organizerName) values.push(organizerName);
  }
  return [...new Set(values)].slice(0, 30);
}

/**
 * Projects a verified Google Calendar trigger into bounded metadata. It does
 * not treat ordinary events as meetings: a supported video-conference URL is
 * required except for cancellation reconciliation.
 */
export function parseGoogleCalendarMeetingTrigger(triggerSlug: unknown, payload: unknown): CalendarMeetingCandidate | undefined {
  const lifecycle = CALENDAR_TRIGGER_LIFECYCLES[String(triggerSlug ?? "").trim().toUpperCase()];
  if (!lifecycle) return undefined;
  const root = record(payload);
  if (!root) return undefined;
  const event = record(root.event) ?? record(root.calendarEvent) ?? record(root.calendar_event) ?? record(root.data) ?? root;
  const source = [event, root];
  const meetingUrl = conferenceUrl(source);
  const calendarEventId = firstText(source, ["eventId", "event_id", "calendarEventId", "calendar_event_id", "id"], 240);
  const title = firstText(source, ["summary", "title", "eventTitle", "event_title", "name"], 180);
  // For an update that removes its conference link, retain just enough stable
  // event identity to reconcile and cancel a previously scheduled bot.
  // Ignore unrelated non-meeting events that have no stable Calendar ID.
  if (!meetingUrl && lifecycle !== "cancelled" && !calendarEventId) return undefined;
  const startAt = firstNestedText(source, ["start", "startTime", "start_time"], 80) ?? firstText(source, ["startAt", "start_at", "startTime", "start_time"], 80);
  const endAt = firstNestedText(source, ["end", "endTime", "end_time"], 80) ?? firstText(source, ["endAt", "end_at", "endTime", "end_time"], 80);
  return {
    lifecycle,
    ...(calendarEventId ? { calendarEventId } : {}),
    ...(title ? { title } : {}),
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    participants: participantNames(source),
    ...(meetingUrl ? { meetingUrl } : {}),
  };
}

function encryptionKey(): Buffer {
  if (!config.webhookSecret) throw new Error("WEBHOOK_SECRET is required to protect calendar meeting preparations");
  return createHash("sha256").update(`chusky:calendar-meeting-preparation:v1:${config.webhookSecret}`).digest();
}

/** Encrypt a meeting link at rest; it is never placed in history, logs, or a tool result. */
export function sealCalendarMeetingUrl(url: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function openCalendarMeetingUrl(sealed: string): string {
  const [version, ivText, tagText, ciphertext] = sealed.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertext) throw new Error("Calendar meeting preparation cannot be opened");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new Error("Calendar meeting preparation cannot be opened"); }
}
