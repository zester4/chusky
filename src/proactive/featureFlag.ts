/**
 * Elena-owned native capabilities. Keep this list narrow: disabling Elena
 * must remove the Pulse control plane from model-facing discovery, while
 * leaving unrelated reminders, tasks, missions, and connected-app triggers
 * available to Chusky.
 */
export const ELENA_TOOL_SLUGS = new Set([
  "CHUCK_ATTENTION_STATE",
  "CHUCK_ATTENTION_PULSE",
  "CHUCK_AUTONOMY_STATUS",
  "CHUCK_AUTONOMY_RECONCILE",
  "CHUCK_AUTONOMY_PLAYBOOK",
]);

export const ELENA_DISABLED_PROMPT = `Elena and Attention Pulse are disabled for this deployment by CHUSKY_ELENA_ENABLED=false. Do not mention, suggest, schedule, inspect, or claim Elena, Attention Pulse, autonomy-watch, or Pulse-only tools. Continue using Chusky's ordinary conversation, connected-app, trigger, task, and approval capabilities.`;

export function isElenaToolSlug(slug: string): boolean {
  return ELENA_TOOL_SLUGS.has(slug.trim().toUpperCase());
}

export function elenaDisabledMessage(): string {
  return "Elena and Attention Pulse are disabled by CHUSKY_ELENA_ENABLED=false.";
}
