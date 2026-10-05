import { config } from "../config.js";
import { jevClient, jevEnabled, jevText, withinBudget, type JevClient } from "./jev.js";
import { logger } from "../logger.js";

export async function meetingDisclosureCheck(input: {
  text: string;
  usedRecordTool: boolean;
  verifiedParticipant: boolean;
  client?: JevClient;
  sessionId?: string;
}): Promise<{ allowed: boolean; reason: string; shadow: boolean }> {
  const deterministicRisk = input.usedRecordTool && !input.verifiedParticipant;
  const fallback = { allowed: !deterministicRisk, reason: deterministicRisk ? "record lookup lacks confirmed participant scope" : "no unconfirmed record disclosure detected", shadow: true };
  if (!config.meetingDisclosureGateEnabled) {
    logger.info({ event: "meeting.disclosure", shadow: true, proposed: fallback.allowed, deterministicRisk, usedRecordTool: input.usedRecordTool, verifiedParticipant: input.verifiedParticipant }, "Meeting disclosure decision");
    return { ...fallback, allowed: true, reason: "gate disabled; decision logged", shadow: true };
  }
  if (!jevEnabled("memory")) return config.meetingDisclosureGateMode === "enforce" ? fallback : { ...fallback, allowed: true, reason: "shadow decision recorded", shadow: true };
  const client = input.client ?? jevClient();
  if (!client.available()) return config.meetingDisclosureGateMode === "enforce"
    ? { ...fallback, reason: "Jev unavailable; deterministic boundary retained", shadow: false }
    : { ...fallback, allowed: true, reason: "Jev unavailable in shadow mode", shadow: true };
  const result = await withinBudget(client.evaluate({ text: jevText(input.text, 1_500), used_record_tool: input.usedRecordTool, verified_participant: input.verifiedParticipant }, {
    disclosure: { type: "choice", instructions: "Would this meeting reply reveal private owner data, another person's record, internal notes, or negotiation strategy beyond a verified participant's scope?", criteria: { allow: "The reply is appropriately scoped.", block: "The reply may disclose private or out-of-scope information." } },
  }, { sessionId: input.sessionId }), 400);
  if (!result) return config.meetingDisclosureGateMode === "enforce"
    ? { ...fallback, reason: "Jev timed out; deterministic boundary retained", shadow: false }
    : { ...fallback, allowed: true, reason: "Jev timed out in shadow mode", shadow: true };
  const answer = result.answers.disclosure;
  const proposed = answer?.type === "choice" ? answer.choice === "allow" && answer.confidence >= 0.9 : false;
  logger.info({ event: "meeting.disclosure", shadow: config.meetingDisclosureGateMode !== "enforce", proposed, deterministicRisk, usedRecordTool: input.usedRecordTool, verifiedParticipant: input.verifiedParticipant }, "Meeting disclosure decision");
  if (config.meetingDisclosureGateMode !== "enforce") return { ...fallback, allowed: true, reason: "shadow decision recorded", shadow: true };
  return proposed && fallback.allowed ? { allowed: true, reason: "Jev allowed within deterministic boundary", shadow: false } : { allowed: false, reason: "Meeting disclosure gate refused or was uncertain", shadow: false };
}
