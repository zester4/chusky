import type { PhoneCallRecord } from "../store.js";

export type VoiceCapabilityBundle =
  | "calendar"
  | "crm"
  | "email"
  | "messaging"
  | "support"
  | "billing"
  | "orders"
  | "documents"
  | "meetings";

export type VoiceToolInterruptionMode =
  | "allow"
  | "disable_during_tool"
  | "disable_during_tool_and_turn";

export type VoiceVoicemailPolicy = "detect_and_handle" | "not_configured";

export interface VoiceCallPlan {
  direction: "inbound" | "outbound";
  callProfile: "personal" | "business";
  representedParty: string;
  objective: string;
  callerFacingTopic: string;
  verificationTier: "public" | "identified" | "verified";
  capabilityBundles: VoiceCapabilityBundle[];
  voicemailPolicy: VoiceVoicemailPolicy;
  defaultToolInterruptionMode: VoiceToolInterruptionMode;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function purposeText(call: PhoneCallRecord): string {
  return clean(call.purpose, 1_000) || "Have the approved conversation.";
}

function callerFacingTopic(purpose: string): string {
  let topic = purpose
    .replace(/(?:[.!?]\s*|[,;]\s*)(?:if|when|once|after)\s+[^.!?;]{1,180}?\b(?:agrees?|confirms?|accepts?|says?\s+yes)\b[\s\S]*$/i, "")
    .replace(/(?:[.!?]\s+)(?:confirm the agreement|then\s+|do not\s+|end the call\b)[\s\S]*$/i, "")
    .replace(/^(?:please\s+)?(?:ask|check|confirm)\s+(?:if|whether)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))(?:(?:\s+(?:will|would|can|could|is|are))|(?:'ll|’ll))\s+be\s+available\s+for\s+/i, "your availability for ")
    .replace(/(?:,?\s+)(?:if|when|once|after)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))\b[\s\S]*$/i, "")
    .replace(/(?:,?\s+)(?:then|and\s+then)\s+(?:book|schedule|create|send|update|confirm|add|save)\b[\s\S]*$/i, "")
    .replace(/(?:,?\s+)(?:if|when|once)\s+(?:they|he|she|you|the\s+(?:client|customer|patient|recipient))\s+(?:agree|agrees|confirm|confirms|accept|accepts|say\s+yes)\b[\s\S]*$/i, "")
    .replace(/[;,.:]+\s*$/, "")
    .trim();
  if (/^(?:confirm|check|ask)\b/i.test(topic)) {
    const subject = topic.match(/\b(the\s+(?:appointment|meeting|booking|order|invoice|payment|service\s+request|delivery|reservation)\b[^,.;]*)/i)?.[1];
    if (subject) topic = subject.replace(/\s+(?:and\s+)?(?:book|schedule|create|send|update|confirm|add|save)\b[\s\S]*$/i, "").trim();
  }
  return topic || "the reason for this call";
}

function bundlesForPurpose(purpose: string): VoiceCapabilityBundle[] {
  const value = purpose.toLowerCase();
  const bundles = new Set<VoiceCapabilityBundle>();
  const add = (bundle: VoiceCapabilityBundle) => bundles.add(bundle);

  if (/calendar|appointment|booking|book|schedule|meeting|availability|reschedul|cancel/.test(value)) add("calendar");
  if (/customer|client|lead|contact|patient|follow[- ]?up|crm|account/.test(value)) add("crm");
  if (/email|e-mail|inbox|send an? message|reply/.test(value)) add("email");
  if (/text|sms|telegram|slack|message|notify|remind/.test(value)) add("messaging");
  if (/support|ticket|issue|case|complaint|escalat/.test(value)) add("support");
  if (/invoice|payment|billing|refund|charge|debt|collection/.test(value)) add("billing");
  if (/order|delivery|shipment|return|product|inventory/.test(value)) add("orders");
  if (/document|spreadsheet|sheet|report|form|file/.test(value)) add("documents");
  if (/transcript|call history|meeting notes|minutes/.test(value)) add("meetings");

  return [...bundles];
}

/**
 * Build a bounded, deterministic control plan before the model sees a call.
 * The plan is context, not authorization: action tools still enforce their
 * normal approvals and provider receipt checks.
 */
export function buildVoiceCallPlan(call: PhoneCallRecord): VoiceCallPlan {
  const direction = call.direction === "inbound" ? "inbound" : "outbound";
  const callProfile = call.callProfile === "business" ? "business" : "personal";
  const purpose = purposeText(call);
  const organization = clean(call.voiceProfile?.organization, 180);
  const representedParty = organization || (callProfile === "business" ? "the represented business" : "the owner who requested the call");
  const verificationTier = call.callVerification ?? (callProfile === "business" ? "identified" : "verified");
  const capabilityBundles = bundlesForPurpose(purpose);

  return {
    direction,
    callProfile,
    representedParty,
    objective: purpose,
    callerFacingTopic: callerFacingTopic(purpose),
    verificationTier,
    capabilityBundles,
    voicemailPolicy: direction === "outbound" ? "detect_and_handle" : "not_configured",
    defaultToolInterruptionMode: "allow",
  };
}

/** Classify tool execution before dispatch so reads stay conversational while
 * committed writes cannot be accidentally interrupted halfway through. */
export function voiceToolInterruptionMode(toolName: string): VoiceToolInterruptionMode {
  const value = toolName.toLowerCase();
  if (/refund|charge|payment|delete|cancel|transfer|dtmf|end[_-]?call|send[_-]?(email|message|sms)|create.*(?:invoice|event)|book|patch.*event|update.*(?:contact|ticket)/.test(value)) {
    return "disable_during_tool_and_turn";
  }
  if (/create|update|write|send|reply|schedule|reschedul/.test(value)) return "disable_during_tool";
  return "allow";
}

export function voiceCallPlanInstructions(plan: VoiceCallPlan): string {
  const bundles = plan.capabilityBundles.length ? plan.capabilityBundles.join(", ") : "none selected from the call purpose";
  return [
    "DETERMINISTIC CALL CONTROL PLAN — internal context; never read this aloud.",
    `Call direction: ${plan.direction}. Call profile: ${plan.callProfile}. Represented party: ${plan.representedParty}.`,
    `Objective: ${plan.objective}. Caller-facing topic: ${plan.callerFacingTopic}.`,
    `Verification tier: ${plan.verificationTier}. Capability bundles available for this call: ${bundles}.`,
    `Voicemail policy: ${plan.voicemailPolicy}. Default tool interruption mode: ${plan.defaultToolInterruptionMode}.`,
    "Keep the external person separate from the owner. Use only the selected capability bundles, route unsupported needs to a truthful fallback or human handoff, and never treat this plan as approval for a state-changing action.",
  ].join(" ");
}
