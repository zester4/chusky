import { buildArtifactUploadArguments, type BridgeFile } from "./artifactBridge.js";

type Schema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};

type UrlCandidate = {
  path: string[];
  kind: "string" | "array";
  score: number;
};

type FileUploadCandidate = {
  path: string[];
  kind: "file" | "array";
};

const MAX_IMAGE_TRANSFER_BYTES = 25 * 1024 * 1024;

const MEDIA_URL_NAMES = new Set([
  "image_url", "imageurl", "media_url", "mediaurl", "photo_url", "photourl",
  "picture_url", "pictureurl", "asset_url", "asseturl", "media_urls", "image_urls",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function typeIs(schema: Schema | undefined, expected: string): boolean {
  return schema?.type === expected || (Array.isArray(schema?.type) && schema.type.includes(expected));
}

function candidateScore(key: string, schema: Schema): number {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const description = `${schema.description ?? ""}`.toLowerCase();
  const urlNamed = /^(?:image|media|photo|picture|asset)urls?$/.test(normalized);
  const describedAsUrl = /(?:image|media|photo|picture).{0,24}(?:url|https?)|(?:url|https?).{0,24}(?:image|media|photo|picture)/.test(description);
  if (!MEDIA_URL_NAMES.has(key.toLowerCase()) && !urlNamed && !describedAsUrl) return 0;
  let score = 0;
  if (MEDIA_URL_NAMES.has(key.toLowerCase())) score += 100;
  if (normalized.includes("image")) score += 60;
  if (normalized.includes("media")) score += 55;
  if (normalized.includes("photo") || normalized.includes("picture")) score += 50;
  if (/image\s*url|media\s*url|photo\s*url|public\s+url|https?\s+url/.test(description)) score += 40;
  return score;
}

function findMediaUrlCandidates(schema: Schema | undefined, prefix: string[] = []): UrlCandidate[] {
  if (!schema || !isObject(schema.properties)) return [];
  const candidates: UrlCandidate[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    const path = [...prefix, key];
    const score = candidateScore(key, property);
    if (score > 0 && typeIs(property, "string")) candidates.push({ path, kind: "string", score });
    if (score > 0 && typeIs(property, "array") && property.items && typeIs(property.items, "string")) candidates.push({ path, kind: "array", score });
    if (typeIs(property, "object")) candidates.push(...findMediaUrlCandidates(property, path));
  }
  return candidates;
}

function findFileUploadCandidates(schema: Schema | undefined, prefix: string[] = []): FileUploadCandidate[] {
  if (!schema || !isObject(schema.properties)) return [];
  const candidates: FileUploadCandidate[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    const path = [...prefix, key];
    if ((property as Schema & { file_uploadable?: boolean }).file_uploadable === true) {
      candidates.push({ path, kind: typeIs(property, "array") ? "array" : "file" });
      continue;
    }
    if (typeIs(property, "array") && (property.items as (Schema & { file_uploadable?: boolean }) | undefined)?.file_uploadable === true) {
      candidates.push({ path, kind: "array" });
      continue;
    }
    if (typeIs(property, "object")) candidates.push(...findFileUploadCandidates(property, path));
  }
  return candidates;
}

export function hasComposioFileUploadField(inputSchema: unknown): boolean {
  return isObject(inputSchema) && findFileUploadCandidates(inputSchema as Schema).length > 0;
}

export function composioFileUploadValidationSchema(inputSchema: unknown): unknown {
  if (!isObject(inputSchema)) throw new Error("The selected app action has no usable argument schema.");
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isObject(value)) return value;
    if (value.file_uploadable === true) {
      return {
        type: "object",
        properties: {
          name: { type: "string" },
          mimetype: { type: "string" },
          s3key: { type: "string" },
        },
        required: ["name", "mimetype", "s3key"],
        additionalProperties: false,
      };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  };
  return normalize(inputSchema);
}

export function buildComposioFileUploadArguments(
  inputSchema: unknown,
  actionArguments: Record<string, unknown>,
  uploadedFile: { name: string; mimetype: string; s3key: string },
): Record<string, unknown> {
  if (!isObject(inputSchema) || !isObject(actionArguments)) throw new Error("The selected app action has no usable argument schema.");
  const candidates = findFileUploadCandidates(inputSchema as Schema);
  if (candidates.length !== 1) throw new Error("The selected app action must expose exactly one schema-declared file upload field.");
  const candidate = candidates[0]!;
  const location = findAtPath(actionArguments, candidate.path);
  if (location.exists) throw new Error(`Do not supply ${candidate.path.join(".")}; Chusky fills it with the owner image.`);
  const result = structuredClone(actionArguments) as Record<string, unknown>;
  let cursor = result;
  for (const segment of candidate.path.slice(0, -1)) {
    if (!isObject(cursor[segment])) throw new Error(`The file upload field ${candidate.path.join(".")} has an invalid parent object.`);
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[candidate.path[candidate.path.length - 1]!] = candidate.kind === "array" ? [uploadedFile] : uploadedFile;
  return result;
}

export function hasMediaUrlField(inputSchema: unknown): boolean {
  if (!isObject(inputSchema)) return false;
  return findMediaUrlCandidates(inputSchema as Schema).length > 0;
}

function findAtPath(value: Record<string, unknown>, path: string[]): { parent: Record<string, unknown>; key: string; exists: boolean } {
  let parent = value;
  for (const segment of path.slice(0, -1)) {
    const next = parent[segment];
    if (!isObject(next)) return { parent, key: path[path.length - 1]!, exists: false };
    parent = next;
  }
  const key = path[path.length - 1]!;
  return { parent, key, exists: Object.hasOwn(parent, key) };
}

function setAtPath(value: Record<string, unknown>, path: string[], mediaUrl: string, kind: UrlCandidate["kind"]): Record<string, unknown> {
  const result = structuredClone(value) as Record<string, unknown>;
  let cursor = result;
  for (const segment of path.slice(0, -1)) {
    const current = cursor[segment];
    if (!isObject(current)) throw new Error(`The media URL field ${path.join(".")} has an invalid parent object.`);
    cursor = current;
  }
  cursor[path[path.length - 1]!] = kind === "array" ? [mediaUrl] : mediaUrl;
  return result;
}

/**
 * Add one owner-scoped image to an exact connected-app action. URL-based
 * actions receive a short-lived HTTPS object URL; binary actions reuse the
 * existing schema-checked artifact bridge. A provider schema that exposes
 * more than one plausible media field is rejected instead of guessed.
 */
export function buildMediaBridgeArguments(
  inputSchema: unknown,
  actionArguments: Record<string, unknown>,
  file: BridgeFile,
  mediaUrl?: string,
): { arguments: Record<string, unknown>; mode: "url" | "binary" } {
  if (!isObject(inputSchema)) throw new Error("The selected app action has no usable argument schema.");
  if (!isObject(actionArguments)) throw new Error("arguments must be an object matching the selected app action.");
  if (!Buffer.isBuffer(file.data) || file.data.length === 0 || file.data.length > MAX_IMAGE_TRANSFER_BYTES) throw new Error("The image must contain 1 byte to 25 MB.");

  const urlCandidates = findMediaUrlCandidates(inputSchema as Schema);
  if (urlCandidates.length > 1) throw new Error("The selected app action exposes multiple possible media URL fields; choose a dedicated upload action.");
  if (urlCandidates.length === 1) {
    const best = urlCandidates[0]!;
    if (!mediaUrl) throw new Error("This action requires a valid temporary owner-scoped HTTPS media URL.");
    let parsedUrl: URL;
    try { parsedUrl = new URL(mediaUrl); } catch { throw new Error("This action requires a valid temporary owner-scoped HTTPS media URL."); }
    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password) throw new Error("This action requires a valid temporary owner-scoped HTTPS media URL.");
    const location = findAtPath(actionArguments, best.path);
    if (location.exists) throw new Error(`Do not supply ${best.path.join(".")}; Chusky fills it from the owner image after approval.`);
    return { arguments: setAtPath(actionArguments, best.path, mediaUrl, best.kind), mode: "url" };
  }

  return { arguments: buildArtifactUploadArguments(inputSchema, actionArguments, file), mode: "binary" };
}
