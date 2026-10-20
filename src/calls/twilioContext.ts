import type { Message, PhoneCallRecord } from "../store.js";
import { voiceContinuityInstructions } from "./continuity.js";
import { safeVoiceIdentity, voiceProfileInstructions } from "./voiceProfile.js";
import { buildVoiceCallPlan, voiceCallPlanInstructions } from "./voicePlan.js";
import { voicePolicyInstructions } from "./voiceToolPolicy.js";

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

function callerFacingReason(topic: string): string {
  const value = topic.trim();
  if (!value) return "I'm calling about the reason for this call.";
  const lower = value.charAt(0).toLowerCase() + value.slice(1);
  return /^(?:confirm|check|follow up|ask|verify|schedule|book|discuss|find out)\b/i.test(value)
    ? `I'm calling to ${lower}.`
    : `I'm calling about ${lower}.`;
}

/** Direction-aware short opening for the transport layer. This runs before the
 * first caller transcript, so it cannot depend on the model inferring the call
 * role, configured identity, or purpose from a generic greeting. */
export function twilioVoiceOpening(call: PhoneCallRecord): string {
  const profile = call.voiceProfile;
  const identity = spoken(safeVoiceIdentity(profile?.identity), 180);
  const organization = spoken(profile?.organization, 180);
  const contactName = spoken(profile?.contactName, 180);
  const explicitAi = profile?.disclosure === "explicit_ai";
  const role = explicitAi ? "an AI assistant" : "an assistant";
  if (call.direction === "outbound") {
    const representation = organization
      ? `${role} from ${organization}`
      : call.callProfile === "business"
        ? `${role} for the business I represent`
        : `${role} calling on behalf of the person who asked me to reach you`;
    const greeting = contactName ? `Hi ${contactName},` : "Hi,";
    return `${greeting} this is ${identity}, ${representation}. ${callerFacingReason(callerFacingCallTopic(call.purpose))} Is now a good time to talk for a minute?`;
  }
  return organization
    ? `Hello, this is ${identity}, ${role} from ${organization}. How may I help you today?`
    : `Hello, this is ${identity}, ${role}. How may I help you today?`;
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
export function twilioVoiceHistory(call: PhoneCallRecord, spokenOpening?: string): Message[] {
  const opening = spoken(spokenOpening, 1_000);
  const hasPersistedOpening = (call.transcript?.turns ?? []).some((turn) => turn.kind === "opening" || turn.id === "opening");
  return [
    ...(opening && !hasPersistedOpening ? [{ role: "assistant" as const, content: opening, createdAt: call.createdAt }] : []),
    ...(call.transcript?.turns ?? []).flatMap((turn) => [
    ...(turn.caller ? [{ role: "user" as const, content: `The external contact said: ${turn.caller}`, createdAt: turn.at }] : []),
    ...(turn.assistant ? [{ role: "assistant" as const, content: turn.assistant, createdAt: turn.at }] : []),
    ]),
  ].slice(-24);
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
  const bookingContract = voiceActionNeedsProviderReceipt(call)
    ? " BOOKING COMPLETION CONTRACT: This call includes a booking objective. Treat booking as unfinished until the calendar provider returns a successful create or update receipt. While the caller is available, collect the appointment subject or service, the exact date and time with timezone, and the duration or end time; use a configured service duration when one exists. Ask for one missing detail at a time. Ask for a location or meeting link only when the appointment type or provider requires it. Check real calendar availability, offer only available times, let the caller choose, then create the event and wait for the provider receipt. Never say booked, confirmed, scheduled, updated, or all set after only a free/busy check or a spoken intention. If the caller will not supply a required detail or the provider is unavailable, say plainly that it remains unbooked and leave a verified follow-up for the owner; do not silently send an SMS or email unless that action is explicitly authorized and a valid channel is available."
    : "";
  return `${voiceProfileInstructions(call.voiceProfile, call.direction, purpose)} ${voiceCallPlanInstructions(plan)} ${voicePolicyInstructions(call.voiceProfile?.toolPolicy)} Caller-facing topic stated in the opening: ${callerTopic}. ${contactName ? `The transport greeting has already addressed ${contactName}. Continue with the reason for the call; do not ask who they are or repeat their name.` : "No contact name was supplied; do not invent one."} The transport greeting already identifies the configured representative, organization, and reason for calling, then asks whether this is a good time. Do not ask who the caller is, whether this is a call, or why you called. If the caller says this is the wrong number or the wrong contact, do not disclose private details; politely end or ask whether the correct contact is available. If the opening is already in the conversation history, do not restart it. Call profile: ${profile}. Inbound verification tier: ${verification} (public → identified → verified). Use only this call's transcript and the approved call context as working context; do not consult unrelated chat messages, files, images, or prior conversations. In a business call, do not volunteer unrelated personal information; in a personal call, do not reveal unrelated confidential business information. Never disclose sensitive account information before the configured verification tier is satisfied. UI icons, emoji, tool labels, and internal progress messages are not caller-facing language and must never be spoken.${bookingContract}${continuity}`;
}

/** Scheduling answers are buffered until the provider returns a write receipt.
 * This prevents a model sentence such as “you are all set” from becoming a
 * false booking confirmation when only free/busy was checked. */
export function voiceActionNeedsProviderReceipt(call: PhoneCallRecord): boolean {
  return call.voiceProfile?.mode === "scheduling" || /\b(?:book|booking|schedule|scheduled|appointment|calendar|reserve|reservation)\b/i.test(call.purpose);
}

export function sanitizeUnverifiedVoiceAction(call: PhoneCallRecord, text: string, verifiedActions: Array<{ toolSlug: string; receiptId: string }>): string {
  const answer = text.trim();
  if (!answer || !voiceActionNeedsProviderReceipt(call)) return answer;
  const hasBookingWrite = verifiedActions.some((action) => /(?:CALENDAR|APPOINTMENT|BOOK|SCHEDULE).*(?:CREATE|ADD|UPDATE|INSERT|BOOK|EVENT)|(?:CREATE|ADD|UPDATE|INSERT|BOOK).*(?:CALENDAR|APPOINTMENT|EVENT)/i.test(action.toolSlug));
  if (hasBookingWrite || !/\b(?:booked|scheduled|reserved|all set|appointment (?:is )?confirmed|updated your appointment|created the event)\b/i.test(answer)) return answer;
  return "I have noted that time as your preference, but I have not booked the appointment yet. I still need to confirm the appointment details and calendar availability before I can say it is booked.";
}
