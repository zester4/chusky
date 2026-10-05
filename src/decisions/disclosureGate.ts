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
  const deterministicRisk = /\b(owner|ceo|salary|home address|phone number|private|internal notes|other participant|negotiation|password|email)\b/i.test(input.text);
  const fallback = { allowed: !(input.usedRecordTool && !input.verifiedParticipant) && !deterministicRisk, reason: deterministicRisk ? "possible private disclosure" : "deterministic meeting boundary", shadow: true };
  if (!config.meetingDisclosureGateEnabled || !jevEnabled("memory")) return fallback;
  const client = input.client ?? jevClient();
  if (!client.available()) return { ...fallback, reason: "Jev unavailable; deterministic boundary retained" };
  const result = await withinBudget(client.evaluate({ text: jevText(input.text, 1_500), used_record_tool: input.usedRecordTool, verified_participant: input.verifiedParticipant }, {
    disclosure: { type: "choice", instructions: "Would this meeting reply reveal private owner data, another person's record, internal notes, or negotiation strategy beyond a verified participant's scope?", criteria: { allow: "The reply is appropriately scoped.", block: "The reply may disclose private or out-of-scope information." } },
  }, { sessionId: input.sessionId }), 400);
  if (!result) return { ...fallback, reason: "Jev timed out; deterministic boundary retained" };
  const answer = result.answers.disclosure;
  const proposed = answer?.type === "choice" ? answer.choice === "allow" && answer.confidence >= 0.9 : false;
  logger.info({ event: "meeting.disclosure", shadow: config.meetingDisclosureGateMode !== "enforce", proposed, deterministicRisk, usedRecordTool: input.usedRecordTool, verifiedParticipant: input.verifiedParticipant }, "Meeting disclosure decision");
  if (config.meetingDisclosureGateMode !== "enforce") return { ...fallback, reason: "shadow decision recorded" };
  return proposed && fallback.allowed ? { allowed: true, reason: "Jev allowed within deterministic boundary", shadow: false } : { allowed: false, reason: "Meeting disclosure gate refused or was uncertain", shadow: false };
}
