import type { PhoneCallRecord } from "../store.js";
import { voiceContinuityInstructions } from "./continuity.js";
import { voiceProfileInstructions } from "./voiceProfile.js";

function spoken(value: unknown, maximum: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

/** Direction-aware first sentence for the transport layer. This runs before
 * the first caller transcript, so it cannot depend on the model inferring the
 * call role from a generic greeting. */
export function twilioVoiceOpening(call: PhoneCallRecord): string {
  const profile = call.voiceProfile;
  const identity = spoken(profile?.identity || "Chusky", 180);
  const organization = spoken(profile?.organization, 180);
  const purpose = spoken(call.purpose, 600) || "the reason for this call";
  if (call.direction === "outbound") {
    const representation = organization
      ? `on behalf of ${organization}`
      : call.callProfile === "business"
        ? "on behalf of the business I represent"
        : "on behalf of the person who asked me to reach you";
    return `Hello, this is ${identity}, an AI assistant calling ${representation}. I’m calling about ${purpose}. Is now a good time to speak?`;
  }
  return organization
    ? `Hello, this is ${identity}, an AI assistant with ${organization}. How may I help you today?`
    : `Hello, this is ${identity}, an AI assistant. How may I help you today?`;
}

/** Keep the external speaker distinct from the owner's private chat history. */
export function twilioVoiceTranscript(call: PhoneCallRecord, transcript: string): string {
  const speaker = call.direction === "outbound"
    ? "The external contact answering the outbound call said"
    : "The external caller on the inbound call said";
  return `${speaker}: ${spoken(transcript, 5_000)}`;
}

/**
 * Trusted call context for the private Chusky-to-voice bridge. The purpose is
 * captured for an outbound call; it is context for a
 * conversation, never authority to execute an external action.
 */
export function twilioVoiceInstructions(call: PhoneCallRecord): string {
  const purpose = call.purpose.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000) || "Have the approved conversation.";
  const profile = call.callProfile === "business" ? "business" : "personal";
  const verification = call.callVerification ?? (profile === "business" ? "identified" : "verified");
  const continuity = voiceContinuityInstructions(call.continuity);
  return `${voiceProfileInstructions(call.voiceProfile, call.direction, purpose)} Call profile: ${profile}. Inbound verification tier: ${verification} (public → identified → verified). Use relevant owner-scoped history, memory, knowledge, and connected tools as private working context. In a business call, do not volunteer unrelated personal information; in a personal call, do not reveal unrelated confidential business information. Never disclose sensitive account information before the configured verification tier is satisfied.${continuity}`;
}
