import type { PhoneCallRecord } from "../store.js";
import { voiceProfileInstructions } from "./voiceProfile.js";

/**
 * Trusted call context for the private Chusky-to-voice bridge. The purpose is
 * captured when an owner approves an outbound call; it is context for a
 * conversation, never authority to execute an external action.
 */
export function twilioVoiceInstructions(call: PhoneCallRecord): string {
  const purpose = call.purpose.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000) || "Have the approved conversation.";
  return voiceProfileInstructions(call.voiceProfile, call.direction, purpose);
}
