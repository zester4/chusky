import { randomUUID } from "node:crypto";
import { putR2Object, r2Configured, signR2Download } from "../lib/storage/r2.js";
import type { ChannelAttachment } from "./contracts.js";

type GeneratedMedia = { data: Buffer; mediaType?: string; contentType?: string; name?: string; type?: string };

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
    const allowed = mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType === "video/mp4" || mimeType === "video/webm";
    if (!allowed || !item.data?.length || item.data.length > 12 * 1024 * 1024) continue;
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    const key = `sendblue/${userId}/${randomUUID()}.${extension}`;
    await putR2Object(key, item.data, mimeType);
    attachments.push({ id: key, kind: mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "video", mimeType, filename: item.name, sizeBytes: item.data.length, url: await signR2Download(key) });
  }
  return attachments;
}
