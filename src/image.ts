import { randomUUID } from "node:crypto";
import { safeDaytonaPath } from "./lib/daytona/index.js";

export const MAX_GENERATED_IMAGES = 10;
export const IMAGE_ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9", "9:21"] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];
export type ImageResolution = "512" | "1K" | "2K" | "4K";
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageOutputFormat = "png" | "jpeg" | "webp";

export function normalizeImageCount(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") return 1;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_IMAGES) {
    throw new Error(`count must be an integer from 1 to ${MAX_GENERATED_IMAGES}`);
  }
  return count;
}

export function normalizeImageAspectRatio(value: unknown): ImageAspectRatio | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const ratio = String(value).trim() as ImageAspectRatio;
  if (!IMAGE_ASPECT_RATIOS.includes(ratio)) throw new Error(`aspectRatio must be one of: ${IMAGE_ASPECT_RATIOS.join(", ")}`);
  return ratio;
}

export function normalizeImageResolution(value: unknown): ImageResolution | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const resolution = String(value).trim() as ImageResolution;
  if (!["512", "1K", "2K", "4K"].includes(resolution)) throw new Error("resolution must be 512, 1K, 2K, or 4K");
  return resolution;
}

export function normalizeImageQuality(value: unknown): ImageQuality | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const quality = String(value).trim() as ImageQuality;
  if (!["auto", "low", "medium", "high"].includes(quality)) throw new Error("quality must be auto, low, medium, or high");
  return quality;
}

export function normalizeImageOutputFormat(value: unknown): ImageOutputFormat | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const format = String(value).trim().toLowerCase() as ImageOutputFormat;
  if (!["png", "jpeg", "webp"].includes(format)) throw new Error("outputFormat must be png, jpeg, or webp");
  return format;
}

export function resolveImageWorkspacePath(value: unknown, index: number, total: number, extension: string): string {
  const requested = value === undefined || value === null || String(value).trim() === ""
    ? `generated/images/${randomUUID()}.${extension}`
    : safeDaytonaPath(value, "workspacePath");
  if (total <= 1) return requested;
  const dot = requested.lastIndexOf(".");
  const suffix = `-${index + 1}`;
  return dot > 0 ? `${requested.slice(0, dot)}${suffix}${requested.slice(dot)}` : `${requested}${suffix}`;
}
