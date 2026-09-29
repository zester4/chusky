const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|credential|private[_-]?key|api[_-]?key)/i;
const BINARY_KEY = /(raw|bytes|base64|binary|attachment.?data|file.?data)/i;

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
  const fields: string[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (fields.length >= 40 || depth > 4 || SENSITIVE_KEY.test(path.split(".").at(-1) ?? "") || BINARY_KEY.test(path.split(".").at(-1) ?? "")) return;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
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
    if (SENSITIVE_KEY.test(key) || BINARY_KEY.test(key)) continue;
    visit(value, key.slice(0, 120), 0);
    if (fields.length >= 40) break;
  }
  return [`Trigger: ${event.triggerSlug || "event"}`, ...(event.toolkit ? [`Toolkit: ${event.toolkit}`] : []), ...(event.connectionId ? [`Connection: ${event.connectionId}`] : []), ...fields].join("\n").slice(0, 3_500);
}
