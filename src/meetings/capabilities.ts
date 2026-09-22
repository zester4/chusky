export type MeetingCapabilityLevel = "supported" | "limited" | "unsupported";

export interface MeetingCapabilities {
  audio: MeetingCapabilityLevel;
  outboundChat: MeetingCapabilityLevel;
  inboundChat: MeetingCapabilityLevel;
  screenShare: MeetingCapabilityLevel;
  participantEvents: MeetingCapabilityLevel;
  speakerEvents: MeetingCapabilityLevel;
  scheduledJoin: MeetingCapabilityLevel;
  waitingRoom: MeetingCapabilityLevel;
  admissionControl: MeetingCapabilityLevel;
  transcript: MeetingCapabilityLevel;
  notes: string[];
}

/**
 * Keep provider capability claims conservative. "limited" means the provider
 * path exists but depends on meeting permissions, account configuration, or a
 * provider-specific restriction. This is surfaced to operators instead of
 * pretending every provider has identical behavior.
 */
export function getMeetingCapabilities(platform: "zoom" | "google_meet" | "microsoft_teams" | "webex"): MeetingCapabilities {
  const common = {
    audio: "supported" as const,
    inboundChat: "supported" as const,
    participantEvents: "supported" as const,
    speakerEvents: "supported" as const,
    scheduledJoin: "supported" as const,
    transcript: "supported" as const,
  };
  switch (platform) {
    case "zoom":
      return { ...common, outboundChat: "supported", screenShare: "supported", waitingRoom: "supported", admissionControl: "limited", notes: ["Outgoing chat and screen context depend on the meeting host and provider permissions."] };
    case "google_meet":
      return { ...common, outboundChat: "supported", screenShare: "supported", waitingRoom: "limited", admissionControl: "limited", notes: ["Chat, admission, and screen context depend on the Google Meet account and meeting policy."] };
    case "microsoft_teams":
      return { ...common, outboundChat: "supported", screenShare: "supported", waitingRoom: "limited", admissionControl: "limited", notes: ["Chat, admission, and screen context depend on tenant policy and meeting permissions."] };
    case "webex":
      return { ...common, outboundChat: "unsupported", screenShare: "unsupported", waitingRoom: "limited", admissionControl: "limited", notes: ["Webex meetings currently support inbound events and audio, but Chusky does not send outbound meeting chat or inspect shared screens."] };
  }
}
