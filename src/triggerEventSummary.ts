const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|credential|private[_-]?key|api[_-]?key)/i;
const BINARY_KEY = /(raw|bytes|base64|binary|attachment.?data|file.?data)/i;
const INTERNAL_KEY = /(^|_)(id|ids|uuid|connection|account|trigger)(_|$)/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(code, 16))));
}

function cleanText(value: string, max = 700): string {
  const withoutMarkup = value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(withoutMarkup)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function providerLabel(slug: string, toolkit?: string): string {
  const value = (toolkit || slug).toLowerCase();
  if (value.includes("gmail") || value.includes("googlemail")) return "Gmail";
  if (value.includes("calendar")) return "Google Calendar";
  if (value.includes("notion")) return "Notion";
  if (value.includes("sheet")) return "Google Sheets";
  if (value.includes("slack")) return "Slack";
  if (value.includes("github")) return "GitHub";
  return (toolkit || slug).replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Connected app";
}

export function triggerEventDisplayName(slug: string, toolkit?: string): string {
  const provider = providerLabel(slug, toolkit);
  const normalized = slug.toUpperCase();
  if (provider === "Gmail" && /NEW.*MESSAGE|MESSAGE/.test(normalized)) return "new Gmail message";
  if (provider === "Google Calendar" && /EVENT|CALENDAR/.test(normalized)) return "calendar update";
  if (normalized.includes("EXPIRED")) return `${provider} connection update`;
  if (normalized.includes("DISABLED")) return `${provider} monitoring update`;
  return `${provider} update`;
}

function matchingValues(value: unknown, keys: Set<string>, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (Array.isArray(value)) return value.slice(0, 8).flatMap((item) => matchingValues(item, keys, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
  const normalizedKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const orderedEntries = [
    ...entries.filter(([key]) => keys.has(normalizedKey(key))),
    ...entries.filter(([key]) => !keys.has(normalizedKey(key))),
  ];
  const result: string[] = [];
  for (const [, nested] of orderedEntries) {
    result.push(...matchingValues(nested, keys, depth + 1));
    if (result.length >= 8) break;
  }
  return result;
}

function firstValue(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const values = matchingValues(payload, new Set(keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ""))));
  return values.map((value) => cleanText(value)).find(Boolean);
}

function emailSummary(event: { triggerSlug: string; payload: Record<string, unknown>; toolkit?: string }): string[] {
  const subject = firstValue(event.payload, ["subject", "emailsubject", "title"]);
  const sender = firstValue(event.payload, ["from", "sender", "sendername", "fromemail", "senderemail"]);
  const recipient = firstValue(event.payload, ["to", "recipient", "toemail"]);
  const date = firstValue(event.payload, ["date", "timestamp", "receivedat", "receivedtime"]);
  const bodyValue = firstValue(event.payload, ["snippet", "preview", "message_text", "messagetext", "body", "content", "text"]);
  const body = bodyValue && /<\/?[a-z][^>]*>/i.test(bodyValue) ? cleanText(bodyValue.replace(/<title[^>]*>[\s\S]*?<\/title>/i, " "), 900) : bodyValue;
  const titleMatch = bodyValue?.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const inferredSubject = subject || (titleMatch?.[1] ? cleanText(titleMatch[1], 240) : undefined);
  return [
    `Event: ${triggerEventDisplayName(event.triggerSlug, event.toolkit)}`,
    ...(sender ? [`From: ${sender}`] : []),
    ...(recipient ? [`To: ${recipient}`] : []),
    ...(inferredSubject ? [`Subject: ${inferredSubject}`] : []),
    ...(date ? [`Received: ${date}`] : []),
    ...(body ? [`Preview: ${body}`] : []),
  ];
}

/**
 * Keep useful nested provider event fields (for example Gmail message subject
 * and body) while bounding size and excluding credentials/binary content.
 * The caller must still label the result as untrusted external data.
 */
export function safeTriggerSummary(event: {
  triggerSlug: string;
  payload: Record<string, unknown>;
  toolkit?: string;
  connectionId?: string;
}): string {
  const isEmail = /gmail|googlemail|outlook|email/i.test(`${event.toolkit ?? ""} ${event.triggerSlug}`);
  if (isEmail) return emailSummary(event).join("\n").slice(0, 3_500);

  const fields: string[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    const leaf = path.split(".").at(-1) ?? "";
    if (fields.length >= 40 || depth > 4 || SENSITIVE_KEY.test(leaf) || BINARY_KEY.test(leaf) || INTERNAL_KEY.test(leaf)) return;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      const text = cleanText(String(value), 2_400);
      if (text) fields.push(`${path}: ${text.slice(0, 2_400)}`);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
        if (SENSITIVE_KEY.test(key) || BINARY_KEY.test(key)) continue;
        visit(nested, `${path}.${key}`.slice(0, 180), depth + 1);
        if (fields.length >= 40) break;
      }
    }
  };
  for (const [key, value] of Object.entries(event.payload ?? {}).slice(0, 30)) {
    if (SENSITIVE_KEY.test(key) || BINARY_KEY.test(key) || INTERNAL_KEY.test(key)) continue;
    visit(value, key.slice(0, 120), 0);
    if (fields.length >= 40) break;
  }
  return [`Event: ${triggerEventDisplayName(event.triggerSlug || "event", event.toolkit)}`, ...fields].join("\n").slice(0, 3_500);
}

export function triggerRecoveryActions(displayName: string): Array<{ id: string; label: string; prompt: string }> {
  return [
    { id: "review", label: "Review", prompt: `Review the saved ${displayName} event, summarize what arrived, tell me what Chusky already did, and recommend the safest next step. Do not replay an external action automatically.` },
    { id: "open-chat", label: "Open in Chat", prompt: `Open the saved ${displayName} event in our conversation and explain the evidence, unresolved decision, and next step. Do not claim an external action succeeded without a provider receipt.` },
  ];
}

function storedSummaryValue(lines: string[], keys: readonly string[]): string | undefined {
  const wanted = new Set(keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!wanted.has(key)) continue;
    const value = line.slice(separator + 1).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Re-render summaries written by older releases without exposing provider
 * payloads, connection identifiers, or raw HTML in the dashboard.
 */
export function displayTriggerSummary(summary: string, triggerSlug: string, toolkit?: string): string {
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isEmail = /gmail|googlemail|outlook|email/i.test(`${toolkit ?? ""} ${triggerSlug}`);
  if (isEmail) {
    const rawBody = storedSummaryValue(lines, ["message_text", "messagetext", "body", "content", "html", "snippet", "preview"]);
    const titleMatch = rawBody?.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const sender = storedSummaryValue(lines, ["from", "sender", "sender_email", "from_email"]);
    const recipient = storedSummaryValue(lines, ["to", "recipient", "to_email"]);
    const subject = storedSummaryValue(lines, ["subject", "email_subject"]) || (titleMatch?.[1] ? cleanText(titleMatch[1], 240) : undefined);
    const received = storedSummaryValue(lines, ["date", "timestamp", "received_at", "received_time"]);
    const preview = rawBody ? cleanText(rawBody.replace(/<title[^>]*>[\s\S]*?<\/title>/i, " "), 900) : undefined;
    return [
      `Event: ${triggerEventDisplayName(triggerSlug, toolkit)}`,
      ...(sender ? [`From: ${cleanText(sender, 240)}`] : []),
      ...(recipient ? [`To: ${cleanText(recipient, 240)}`] : []),
      ...(subject ? [`Subject: ${cleanText(subject, 240)}`] : []),
      ...(received ? [`Received: ${cleanText(received, 120)}`] : []),
      ...(preview ? [`Preview: ${preview}`] : []),
    ].join("\n").slice(0, 3_500);
  }

  const useful = lines.filter((line) => {
    const key = line.split(":", 1)[0]?.trim() ?? "";
    return !/^(trigger|toolkit|connection)$/i.test(key) && !INTERNAL_KEY.test(key) && !SENSITIVE_KEY.test(key) && !BINARY_KEY.test(key);
  }).map((line) => cleanText(line, 2_400)).filter(Boolean).slice(0, 40);
  return [`Event: ${triggerEventDisplayName(triggerSlug, toolkit)}`, ...useful].join("\n").slice(0, 3_500);
}
