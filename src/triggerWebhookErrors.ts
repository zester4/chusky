import { DurableSessionDocumentsIncompleteError } from "./sessionDomains.js";

export interface TriggerWebhookSessionFailure {
  status: 503;
  retryAfterSeconds: 30;
  body: {
    ok: false;
    error: "temporary session storage unavailable";
    retryable: true;
  };
}

/** Convert a durable-session read failure into a safe provider-retry response. */
export function classifyTriggerWebhookSessionFailure(error: unknown): TriggerWebhookSessionFailure | undefined {
  if (!(error instanceof DurableSessionDocumentsIncompleteError)) return undefined;
  return {
    status: 503,
    retryAfterSeconds: 30,
    body: { ok: false, error: "temporary session storage unavailable", retryable: true },
  };
}
