/** Upstash Workflow event IDs accept only these characters. */
export const WORKFLOW_EVENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidWorkflowEventId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && WORKFLOW_EVENT_ID_PATTERN.test(value);
}

/** Build a deterministic event ID without punctuation rejected by Upstash. */
export function workflowEventId(prefix: string, ...parts: Array<string | number>): string {
  const value = [prefix, ...parts.map((part) => String(part))]
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!isValidWorkflowEventId(value)) throw new Error("Invalid workflow event ID");
  return value;
}
