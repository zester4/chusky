import type { Message, PhoneCallRecord } from "../store.js";
import { voiceContinuityInstructions } from "./continuity.js";
import { voiceProfileInstructions } from "./voiceProfile.js";
import { buildVoiceCallPlan, voiceCallPlanInstructions } from "./voicePlan.js";

function spoken(value: unknown, maximum: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

/**
 * Turn the owner's private call objective into a short caller-facing topic.
 * Outbound purposes often contain execution instructions such as "if they
 * agree, book it". Those instructions belong in the agent context, never in
 * the first sentence spoken to the external contact.
 */
export function callerFacingCallTopic(purpose: unknown): string {
  let topic = spoken(purpose, 600);
  if (!topic) return "the reason for this call";

  topic = topic
    .replace(/^(?:please\s+)?(?:ask|check|confirm)\s+(?:if|whether)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))(?:(?:\s+(?:will|would|can|could|is|are))|(?:'ll|’ll))\s+be\s+available\s+for\s+/i, "your availability for ")
    .replace(/^(?:please\s+)?confirm\s+if\s+(?:they|he|she|you)(?:(?:\s+(?:will|would|can|could))|(?:'ll|’ll))\s+make\s+it\s+for\s+/i, "your availability for ")
    .replace(/(?:,?\s+)(?:if|when|once|after)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))\b[\s\S]*$/i, "")
    .replace(/(?:,?\s+)(?:then|and\s+then)\s+(?:book|schedule|create|send|update|confirm|add|save)\b[\s\S]*$/i, "")
    .replace(/(?:,?\s+)(?:if|when|once)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))\s+(?:agree|agrees|confirm|confirms|accept|accepts|say\s+yes)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[;,.:]+\s*$/, "")
    .trim();

  return topic || "the reason for this call";
}

/** Direction-aware first sentence for the transport layer. This runs before
 * the first caller transcript, so it cannot depend on the model inferring the
 * call role from a generic greeting. */
export function twilioVoiceOpening(call: PhoneCallRecord): string {
  const profile = call.voiceProfile;
  const identity = spoken(profile?.identity || "Chusky", 180);
  const organization = spoken(profile?.organization, 180);
  const contactName = spoken(profile?.contactName, 180);
  if (call.direction === "outbound") {
    const representation = organization
      ? `on behalf of ${organization}`
      : call.callProfile === "business"
        ? "on behalf of the business I represent"
        : "on behalf of the person who asked me to reach you";
    return `Hello, this is ${identity}, an AI assistant calling ${representation}. ${contactName ? `May I speak with ${contactName}?` : "May I confirm I’m speaking with the intended person?"}`;
  }
  return organization
    ? `Hello, this is ${identity}, an AI assistant with ${organization}. How may I help you today?`
    : `Hello, this is ${identity}, an AI assistant. How may I help you today?`;
}

/** Return approved, bounded vocabulary for Flux recognition on this call. */
export function twilioVoiceKeyterms(call: PhoneCallRecord): string[] {
  const profile = call.voiceProfile;
  const values = [profile?.identity, profile?.organization, ...(profile?.facts ?? [])].filter((value): value is string => Boolean(value));
  const terms: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;
  for (const value of values) {
    const term = spoken(value, 80);
    const key = term.toLowerCase();
    if (!term || seen.has(key) || totalLength + term.length > 2_000 || terms.length >= 50) continue;
    seen.add(key);
    terms.push(term);
    totalLength += term.length;
  }
  return terms;
}

/** Keep the external speaker distinct from the owner's private chat history. */
export function twilioVoiceTranscript(call: PhoneCallRecord, transcript: string, interruptedAssistantSpeech?: string): string {
  const speaker = call.direction === "outbound"
    ? "The external contact answering the outbound call said"
    : "The external caller on the inbound call said";
  const interrupted = spoken(interruptedAssistantSpeech, 2_000);
  const interruptedEnding = interrupted && /[.!?]$/.test(interrupted) ? "" : ".";
  return `${interrupted ? `The assistant was interrupted after saying: ${interrupted}${interruptedEnding} ` : ""}${speaker}: ${spoken(transcript, 5_000)}`;
}

/**
 * A live call must not inherit unrelated chat turns (especially files or
 * image requests) from the owner's global conversation. Only finalized turns
 * from this call and bounded continuity are eligible for the voice model.
 */
export function twilioVoiceHistory(call: PhoneCallRecord): Message[] {
  return (call.transcript?.turns ?? []).flatMap((turn) => [
    { role: "user" as const, content: `The external contact said: ${turn.caller}`, createdAt: turn.at },
    { role: "assistant" as const, content: turn.assistant, createdAt: turn.at },
  ]).slice(-24);
}

/**
 * Trusted call context for the private Chusky-to-voice bridge. The purpose is
 * captured for an outbound call; it is context for a
 * conversation, never authority to execute an external action.
 */
export function twilioVoiceInstructions(call: PhoneCallRecord): string {
  const plan = buildVoiceCallPlan(call);
  const purpose = call.purpose.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000) || "Have the approved conversation.";
  const callerTopic = callerFacingCallTopic(call.purpose);
  const profile = call.callProfile === "business" ? "business" : "personal";
  const verification = call.callVerification ?? (profile === "business" ? "identified" : "verified");
  const continuity = voiceContinuityInstructions(call.continuity);
  const contactName = spoken(call.voiceProfile?.contactName, 180);
  return `${voiceProfileInstructions(call.voiceProfile, call.direction, purpose)} ${voiceCallPlanInstructions(plan)} Caller-facing topic after identity confirmation: ${callerTopic}. ${contactName ? `Expected contact name: ${contactName}. Use it only to confirm identity; do not treat it as proof.` : "No contact name was supplied; do not invent one."} Call profile: ${profile}. Inbound verification tier: ${verification} (public → identified → verified). Use only this call's transcript and the approved call context as working context; do not consult unrelated chat messages, files, images, or prior conversations. In a business call, do not volunteer unrelated personal information; in a personal call, do not reveal unrelated confidential business information. Never disclose sensitive account information before the configured verification tier is satisfied.${continuity}`;
}
