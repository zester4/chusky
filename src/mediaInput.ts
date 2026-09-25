/**
 * Shared user intent for an attachment with no provider caption or text.
 * Keeping this at the multimodal boundary prevents Telegram, SDK, and channel
 * adapters from inventing different prompts for the same user action.
 */
export type MediaInputKind = "image" | "document" | "video" | "attachment";

export function defaultMediaInstruction(kind: MediaInputKind): string {
  switch (kind) {
    case "image":
      return "Inspect the attached image and respond helpfully to the user.";
    case "document":
      return "Read the attached document and respond helpfully to the user.";
    case "video":
      return "Inspect the attached video and respond helpfully to the user.";
    default:
      return "Inspect the attached media and respond helpfully to the user.";
  }
}
