import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAttachment, ChannelMediaError, InboundMessage } from "./contracts.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface DecodedDataUrl {
  mimeType: string;
  bytes: Buffer;
}

/** Decode only strict base64 data URLs. Buffer.from is intentionally lenient. */
export function decodeMediaDataUrl(value: string): DecodedDataUrl | undefined {
  const match = value.match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=]*)$/i);
  if (!match || !BASE64.test(match[2]) || match[2].length % 4 === 1) return undefined;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) return undefined;
  return { mimeType: match[1].toLowerCase(), bytes };
}

/** Identify an image from its bytes instead of trusting a provider MIME header. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  // HEIC/HEIF use an ISO base media `ftyp` box. They are common from iPhones,
  // but are not accepted by the OpenRouter image input contract directly.
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return undefined;
}

function hasValidImageEnvelope(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/jpeg": return bytes.length >= 10 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    case "image/png": return bytes.length >= 24 && bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii") === "IEND";
    case "image/gif": return bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b;
    case "image/webp": return bytes.length >= 20 && bytes.readUInt32LE(4) + 8 <= bytes.length;
    case "image/heic": return bytes.length >= 16;
    default: return false;
  }
}

export function isImageCandidate(attachment: ChannelAttachment, decoded?: DecodedDataUrl): boolean {
  return attachment.kind === "image" || attachment.mimeType?.toLowerCase().startsWith("image/") === true || decoded?.mimeType.startsWith("image/") === true;
}

async function transcodeToJpeg(input: Buffer, executable = "ffmpeg"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "chusky-image-"));
  const source = join(dir, "input-image");
  const output = join(dir, "output.jpg");
  try {
    await writeFile(source, input, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["-nostdin", "-v", "error", "-i", source, "-frames:v", "1", "-q:v", "2", "-y", output], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000); });
      child.once("error", (error) => { clearTimeout(timeout); reject(new Error(`Image converter is unavailable: ${error.message}`)); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Image conversion failed${stderr ? `: ${stderr.trim()}` : ""}`));
      });
    });
    const outputBytes = await readFile(output);
    if (!outputBytes.length || outputBytes.length > MAX_IMAGE_BYTES || sniffImageMime(outputBytes) !== "image/jpeg") throw new Error("Image conversion returned invalid JPEG data");
    return outputBytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Normalize inbound image data once for every channel. Provider MIME headers
 * and extensions are not proof that the downloaded bytes are an image; this
 * boundary prevents malformed CDN responses from reaching the model.
 */
export async function normalizeInboundImages(message: InboundMessage, executable = "ffmpeg"): Promise<InboundMessage> {
  const attachments = await Promise.all(message.attachments.map(async (attachment) => {
    if (!attachment.url?.startsWith("data:")) return attachment;
    const decoded = decodeMediaDataUrl(attachment.url);
    if (!decoded) return attachment.kind === "image" ? { ...attachment, mediaError: "invalid_media" as ChannelMediaError } : attachment;
    const sniffed = sniffImageMime(decoded.bytes);
    if (!isImageCandidate(attachment, decoded) && !sniffed) return attachment;
    if (!sniffed || !hasValidImageEnvelope(decoded.bytes, sniffed)) return { ...attachment, mediaError: "invalid_media" as ChannelMediaError };
    if (decoded.bytes.length > MAX_IMAGE_BYTES) return { ...attachment, mediaError: "too_large" as ChannelMediaError };
    try {
      const jpeg = await transcodeToJpeg(decoded.bytes, executable);
      return { ...attachment, kind: "image" as const, mimeType: "image/jpeg", sizeBytes: jpeg.length, url: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
    } catch {
      return { ...attachment, mediaError: sniffed === "image/heic" ? "unsupported_media_type" as ChannelMediaError : "invalid_media" as ChannelMediaError };
    }
  }));
  return { ...message, attachments };
}
