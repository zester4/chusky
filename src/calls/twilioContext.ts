import type { PhoneCallRecord } from "../store.js";
import { voiceProfileInstructions } from "./voiceProfile.js";

/**
 * Trusted call context for the private Chusky-to-voice bridge. The purpose is
 * captured for an outbound call; it is context for a
 * conversation, never authority to execute an external action.
 */
export function twilioVoiceInstructions(call: PhoneCallRecord): string {
  const purpose = call.purpose.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000) || "Have the approved conversation.";
  const profile = call.callProfile === "business" ? "business" : "personal";
  const verification = call.callVerification ?? (profile === "business" ? "identified" : "verified");
  return `${voiceProfileInstructions(call.voiceProfile, call.direction, purpose)} Call profile: ${profile}. Inbound verification tier: ${verification} (public → identified → verified). Use only this call brief and explicitly approved read-only context; never load the owner's full memory or disclose sensitive account information before verification.`;
}
