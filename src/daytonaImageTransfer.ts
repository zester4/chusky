import { randomUUID } from "node:crypto";
import { hasValidImageEnvelope, sniffImageMime } from "./channels/imageMedia.js";
import { daytonaEngine, safeDaytonaPath } from "./lib/daytona/index.js";
import { readR2Object } from "./lib/storage/r2.js";
import { getImageAsset, saveImageAsset } from "./store.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
type ImageMime = "image/jpeg" | "image/png" | "image/webp";
type RunImage = { data: Uint8Array; mediaType: string; filename?: string };

export type DaytonaImageTransferInput = {
  action: "import" | "export";
  path?: string;
  directory?: string;
  name?: string;
  source?: "current" | "generated" | "asset";
  sourceIndex?: number;
  assetId?: string;
};

export type DaytonaImageTransferRuntime = {
  currentImages?: RunImage[];
  generatedImages?: RunImage[];
};

export type DaytonaImageTransferDependencies = {
  readDaytonaFile: (owner: number, path: string, maxBytes: number) => Promise<Buffer>;
  writeDaytonaFile: (owner: number, path: string, bytes: Buffer) => Promise<{ path: string; bytes: number }>;
  saveAsset: typeof saveImageAsset;
  getAsset: typeof getImageAsset;
  readAsset: typeof readR2Object;
};

const defaultDependencies: DaytonaImageTransferDependencies = {
  readDaytonaFile: (owner, path, maxBytes) => daytonaEngine.readBinaryFile(owner, path, maxBytes),
  writeDaytonaFile: (owner, path, bytes) => daytonaEngine.writeBinaryFile(owner, path, bytes),
  saveAsset: saveImageAsset,
  getAsset: getImageAsset,
  readAsset: readR2Object,
};

function verifiedImage(bytes: Buffer): ImageMime {
  const contentType = sniffImageMime(bytes);
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES || !hasValidImageEnvelope(bytes, contentType ?? "")
    || (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")) {
    throw new Error("Only valid JPEG, PNG, or WebP images up to 25 MB can move between Daytona and Chusky.");
  }
  return contentType;
}

function imageExtension(contentType: ImageMime): string {
  return contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
}

function imageNameHint(value: string): string {
  const lastSegment = value.replaceAll("\\", "/").split("/").at(-1) ?? "image";
  return lastSegment.replace(/\.(?:jpe?g|png|webp)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
}

export async function transferDaytonaImage(
  userId: number,
  input: DaytonaImageTransferInput,
  runtime: DaytonaImageTransferRuntime,
  dependencies: DaytonaImageTransferDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  if (input.action === "import") {
    if (!input.path || input.directory || input.source || input.assetId || input.sourceIndex !== undefined) throw new Error("Daytona image import needs one workspace path and no other source.");
    const path = safeDaytonaPath(input.path);
    const bytes = await dependencies.readDaytonaFile(userId, path, MAX_IMAGE_BYTES);
    const contentType = verifiedImage(bytes);
    const suffix = randomUUID().slice(0, 8);
    const name = `${imageNameHint(input.name || path)}-${suffix}.${imageExtension(contentType)}`;
    const asset = await dependencies.saveAsset(userId, {
      name,
      purpose: "Image imported from the owner's Daytona workspace",
      description: `Imported from ${path}`.slice(0, 4000),
      tags: ["daytona", "imported-image"],
      contentType,
    }, bytes);
    // The agent loop consumes this marker server-side and supplies the image
    // to vision. It keeps the R2 key and image bytes out of Composio arguments.
    return { __chuskyImageAsset: true, ...asset };
  }

  if (input.action !== "export" || input.path || !input.source) throw new Error("Daytona image export needs a source and optional directory.");
  let bytes: Buffer;
  let sourceName = "image";
  if (input.source === "asset") {
    if (!input.assetId || input.sourceIndex !== undefined) throw new Error("Saved image export needs one asset ID.");
    const asset = await dependencies.getAsset(userId, input.assetId);
    if (!asset) throw new Error("The selected owner image asset was not found.");
    bytes = await dependencies.readAsset(asset.r2Key);
    sourceName = asset.name;
  } else {
    if (input.assetId) throw new Error("Current and generated image exports do not accept an asset ID.");
    const index = input.sourceIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index > 9) throw new Error("sourceIndex must be an integer from 0 to 9.");
    const images = input.source === "generated" ? runtime.generatedImages : runtime.currentImages;
    const image = images?.[index];
    if (!image) throw new Error(`No ${input.source} image is available at index ${index}.`);
    bytes = Buffer.from(image.data);
    sourceName = image.filename || `${input.source}-image`;
  }
  const contentType = verifiedImage(bytes);
  const directory = safeDaytonaPath(input.directory || "generated/images", "directory").replace(/\/$/, "");
  const path = `${directory}/${imageNameHint(input.name || sourceName)}-${randomUUID().slice(0, 8)}.${imageExtension(contentType)}`;
  const written = await dependencies.writeDaytonaFile(userId, path, bytes);
  return { imageExported: true, path: written.path, size: written.bytes, contentType };
}
