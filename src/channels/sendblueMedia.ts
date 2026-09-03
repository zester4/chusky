import { randomUUID } from "node:crypto";
import { putR2Object, r2Configured, signR2Download } from "../lib/storage/r2.js";
import type { ChannelAttachment } from "./contracts.js";

type GeneratedMedia = { data: Buffer; mediaType?: string; contentType?: string; name?: string; type?: string };

const extensionForMimeType: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/ogg": "ogg", "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/flac": "flac", "audio/caf": "caf", "audio/x-caf": "caf",
  "video/mp4": "mp4", "video/webm": "webm",
  "application/pdf": "pdf",
};

export function sendblueFileExtensionForMime(mimeType: string): string {
  return extensionForMimeType[mimeType.toLowerCase().split(";", 1)[0]] ?? "bin";
}

/**
 * Sendblue fetches outbound media from HTTPS. R2 gives generated files a
 * bounded, provider-readable URL without putting binary data in Redis or in
 * the Sendblue request body.
 */
export async function persistSendblueMedia(userId: number, images: GeneratedMedia[] = [], files: GeneratedMedia[] = []): Promise<ChannelAttachment[]> {
  if (!r2Configured()) return [];
  const attachments: ChannelAttachment[] = [];
  for (const item of [...images, ...files].slice(0, 5)) {
    const mimeType = (item.mediaType ?? item.contentType ?? "").toLowerCase().split(";", 1)[0];
    const allowed = mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType === "video/mp4" || mimeType === "video/webm" || mimeType === "application/pdf";
    if (!allowed || !item.data?.length || item.data.length > 12 * 1024 * 1024) continue;
    // Sendblue determines attachment rendering from the URL extension. In
    // particular, .caf is the documented Apple inline voice-note format.
    const extension = sendblueFileExtensionForMime(mimeType);
    const key = `sendblue/${userId}/${randomUUID()}.${extension}`;
    await putR2Object(key, item.data, mimeType);
    attachments.push({ id: key, kind: mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video" : "document", mimeType, filename: item.name, sizeBytes: item.data.length, url: await signR2Download(key) });
  }
  return attachments;
}
