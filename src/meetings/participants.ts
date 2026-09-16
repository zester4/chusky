import type { RecallMeetingParticipant, RecallMeetingSpeakerEvent } from "../store.js";

export interface RecallAttributedSpeaker {
  participantId: string;
  name: string;
}

/**
 * Attribute a transcript audio window only when Recall's speaker timeline
 * leaves exactly one rostered participant overlapping it. The widened
 * boundary accounts for cross-service event delivery jitter; overlaps remain
 * ambiguous and are deliberately not guessed.
 */
export function resolveRecallMeetingSpeaker(
  events: RecallMeetingSpeakerEvent[],
  roster: RecallMeetingParticipant[],
  turnStartedAtMs: number,
  turnEndedAtMs: number,
): RecallAttributedSpeaker | undefined {
  if (!Number.isSafeInteger(turnStartedAtMs) || !Number.isSafeInteger(turnEndedAtMs)
    || turnStartedAtMs <= 0 || turnEndedAtMs < turnStartedAtMs
    || turnEndedAtMs - turnStartedAtMs > 120_000) return undefined;

  const boundaryToleranceMs = 1_000;
  const windowStart = turnStartedAtMs - boundaryToleranceMs;
  const windowEnd = turnEndedAtMs + boundaryToleranceMs;
  const ordered = events
    .filter((event) => event && Number.isSafeInteger(event.at) && event.at > 0
      && event.at <= windowEnd && event.at >= turnStartedAtMs - 10 * 60_000
      && (event.type === "speech_on" || event.type === "speech_off")
      && typeof event.participantId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.participantId))
    .slice()
    .sort((a, b) => a.at - b.at
      || Number(a.type !== "speech_off") - Number(b.type !== "speech_off")
      || (a.participantId ?? "").localeCompare(b.participantId ?? ""));

  // Equal-time starts from different people have no ordering information.
  // Treat them as ambiguous instead of letting sort order select a winner.
  const startsAt = new Map<number, string>();
  for (const event of ordered) {
    if (event.type !== "speech_on" || !event.participantId) continue;
    const priorParticipantId = startsAt.get(event.at);
    if (priorParticipantId && priorParticipantId !== event.participantId) return undefined;
    startsAt.set(event.at, event.participantId);
  }

  let activeParticipantId: string | undefined;
  let activeSince: number | undefined;
  const overlappingIds = new Set<string>();
  const addOverlap = (participantId: string, start: number, end: number) => {
    // A very old active-speaker state is not useful evidence for a new turn.
    const boundedStart = Math.max(start, turnStartedAtMs - 60_000);
    const boundedEnd = Math.min(end, start + 120_000);
    if (Math.min(boundedEnd, windowEnd) > Math.max(boundedStart, windowStart)) overlappingIds.add(participantId);
  };
  const closeActive = (at: number) => {
    if (activeParticipantId && activeSince !== undefined) addOverlap(activeParticipantId, activeSince, at);
    activeParticipantId = undefined;
    activeSince = undefined;
  };

  for (const event of ordered) {
    if (event.type === "speech_on") {
      if (!event.participantId) continue;
      if (activeParticipantId !== event.participantId) closeActive(event.at);
      activeParticipantId = event.participantId;
      activeSince = event.at;
      continue;
    }
    if (activeParticipantId === event.participantId) closeActive(event.at);
  }
  if (activeParticipantId && activeSince !== undefined) addOverlap(activeParticipantId, activeSince, windowEnd);

  if (overlappingIds.size !== 1) return undefined;
  const participantId = [...overlappingIds][0];
  const participant = roster.find((item) => item.id === participantId);
  // Never turn a provider's missing/anonymous identity into a confident name.
  // Legacy records without identityStatus were created before this distinction
  // existed and remain compatible as named records.
  if (participant?.identityStatus === "unknown") return undefined;
  const name = participant?.name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return name ? { participantId, name } : undefined;
}
