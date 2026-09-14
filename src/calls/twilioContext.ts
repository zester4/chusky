import type { PhoneCallRecord } from "../store.js";

/**
 * Trusted call context for the private Chusky-to-voice bridge. The purpose is
 * captured when an owner approves an outbound call; it is context for a
 * conversation, never authority to execute an external action.
 */
export function twilioVoiceInstructions(call: PhoneCallRecord): string {
  const purpose = call.purpose.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000);
  const callContext = call.direction === "outbound"
    ? `Approved outbound call objective: ${purpose || "Have the approved conversation."}`
    : "This is an authorized inbound call. Help the caller with their question.";

  return [
    "You are speaking live in a voice call. Be concise, conversational, and easy to hear.",
    callContext,
    "Treat the objective as context, not as authorization. Do not claim to perform an external action during this call; explain the next step or ask the caller to continue in Telegram for approvals or actions.",
  ].join(" ");
}
