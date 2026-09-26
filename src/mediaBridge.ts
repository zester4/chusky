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
  description?: string;
};

export type MediaAttachmentSelection =
  | { source: "current" | "generated"; sourceIndex: number }
  | { source: "asset"; assetId: string }
  | { ambiguous: true; reason: string };

type ImageRetryHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Carry an explicitly requested image action across the narrow retry where
 * the assistant asked the owner to reattach a missing image. This is not an
 * authorization source: the earlier user message must still contain the
 * image action, and unrelated/cancelled follow-ups end the continuation.
 */
export function findPendingImageRetryRequest(
  history: readonly ImageRetryHistoryMessage[],
  currentText: string,
  currentImageCount: number,
): string | undefined {
  const latest = history.at(-1);
  if (latest?.role !== "assistant" || !assistantRequestedImageRetry(latest.content)) return undefined;

  const current = currentText.trim();
  if (isCancelledImageRetry(current)) return undefined;
  if (currentImageCount <= 0 && !/\b(?:retry|try again|re-?attach|here it is|here you go|use (?:it|that image|the image))\b/i.test(current)) return undefined;

  for (const message of [...history.slice(0, -1)].reverse()) {
    if (message.role !== "user") continue;
    const candidate = selectRequestedImage(message.content, { currentCount: 1, generatedCount: 0 });
    if (candidate) return message.content;
    if (isImageRetryAcknowledgement(message.content)) continue;
    return undefined;
  }
  return undefined;
}

function assistantRequestedImageRetry(text: string): boolean {
  const requestsImage = /\b(?:re-?attach|attach|send|upload)\b.{0,120}\b(?:image|photo|picture|graphic|visual)\b/i.test(text);
  const retryWording = /\b(?:re-?attach|again|once more|one more time|retry|try again|re-?attempt|unavailable|not available|missing|could(?:n't| not)|failed|failure)\b/i.test(text);
  const continueAction = /\b(?:so|then|once|after)\b.{0,100}\b(?:continue|proceed|finish|complete|post|publish|send|email|share|upload)\b/i.test(text)
    || /\b(?:and I can|and I'll|and I will)\b.{0,80}\b(?:continue|proceed|finish|complete|post|publish|send|email|share|upload)\b/i.test(text);
  return requestsImage && (retryWording || continueAction);
}

function isCancelledImageRetry(text: string): boolean {
  return /^\s*(?:cancel|stop|never mind|nevermind|no thanks)\b/i.test(text)
    || /\b(?:do not|don't|never)\s+(?:post|publish|send|email|share|upload|retry|reattach)\b/i.test(text)
    || /\b(?:instead|forget it)\b/i.test(text);
}

function isImageRetryAcknowledgement(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  return /^\s*(?:\[attachment\]\s*)?(?:attached:\s*)?(?:image|photo|picture|graphic|visual)(?:\s+attached)?\s*$/i.test(normalized)
    || /\b(?:retry|try again|re-?attach|here it is|here you go|use (?:it|that image|the image))\b/i.test(normalized)
    || /^\s*inspect the attached image and respond helpfully to the user\.?\s*(?:attached:.*)?$/i.test(normalized);
}

type SavedImageCandidate = {
  id: string;
  name: string;
  purpose?: string;
  tags?: readonly string[];
  createdAt?: number;
};

const MAX_IMAGE_TRANSFER_BYTES = 25 * 1024 * 1024;
const BINARY_FIELD_NAMES = new Set(["file_data", "file_content", "content_bytes", "contentbytes", "base64", "data_base64", "content_base64", "bytes_base64"]);

/**
 * Select an image only when the user's request clearly connects it to an
 * external action. This runs at dispatch time so bytes and asset IDs never
 * become model-authored action arguments.
 */
export function selectRequestedImage(
  request: string,
  input: { currentCount: number; generatedCount: number; savedAssets?: readonly SavedImageCandidate[] },
): MediaAttachmentSelection | undefined {
  const text = request.trim();
  if (!text) return undefined;
  const explicitAction = /\b(?:post|publish|share|send|email|attach|include|upload)\b/i.test(text)
    || /\b(?:create|make|draft)\b.{0,40}\b(?:post|email|message|campaign)\b/i.test(text)
    || /\buse\b.{0,80}\b(?:post|email|message|campaign|instagram|linkedin|facebook|twitter|\bx\b)\b/i.test(text);
  if (!explicitAction) return undefined;
  if (/\b(?:without|exclude|omit|leave out)\b.{0,48}\b(?:image|photo|picture|graphic|visual|attachment|it|that)\b/i.test(text)
    || /\b(?:don't|do not|never)\s+(?:attach|include|send|post|publish|share|upload|email)\b.{0,48}\b(?:image|photo|picture|graphic|visual|attachment|it|that)\b/i.test(text)
    || /\b(?:image|photo|picture|graphic|visual|attachment)\b.{0,32}\b(?:not|excluded|omitted)\b/i.test(text)) return undefined;

  const assets = input.savedAssets ?? [];
  const lowered = text.toLocaleLowerCase();
  const namesAsset = assets.some((asset) => (asset.name && lowered.includes(asset.name.toLocaleLowerCase()))
    || (asset.id && lowered.includes(asset.id.toLocaleLowerCase())));
  const namesMedia = /\b(?:image|photo|pic|picture|graphic|visual|artwork|attachment|logo|banner|cover)\b/i.test(text);
  const refersToAvailableMedia = /\b(?:it|this|that|these|those)\b/i.test(text)
    && (input.currentCount > 0 || input.generatedCount > 0 || assets.length > 0);
  const implicitAttachedPost = input.currentCount > 0
    && /\b(?:post|publish|share|upload)\b/i.test(text)
    && !/\b(?:send|email)\b/i.test(text);
  if (!namesMedia && !namesAsset && !refersToAvailableMedia && !implicitAttachedPost) return undefined;

  const namedAssets = assets.filter((asset) => asset.id && asset.name
    && (lowered.includes(asset.name.toLocaleLowerCase()) || lowered.includes(asset.id.toLocaleLowerCase())));
  if (namedAssets.length === 1) return { source: "asset", assetId: namedAssets[0]!.id };
  if (namedAssets.length > 1) return { ambiguous: true, reason: "The request matches more than one saved image. Ask which one to use." };

  const savedCue = /\b(?:saved|previous|earlier|from before|from last time|brand|logo)\b/i.test(text);
  const newestAsset = (): SavedImageCandidate | undefined => {
    if (!assets.length) return undefined;
    if (assets.length === 1) return assets[0];
    const ranked = [...assets].sort((left, right) => (right.createdAt ?? -1) - (left.createdAt ?? -1));
    const newest = ranked[0];
    if (!newest || !Number.isFinite(newest.createdAt)) return undefined;
    if (ranked[1]?.createdAt === newest.createdAt) return undefined;
    return newest;
  };
  if (savedCue && assets.length) {
    if (assets.length === 1) return { source: "asset", assetId: assets[0]!.id };
    if (/\b(?:latest|most recent|newest|last)\b/i.test(text)) {
      const latest = newestAsset();
      if (latest) return { source: "asset", assetId: latest.id };
    }
    return { ambiguous: true, reason: "Several saved images could match. Ask which image to use before posting or sending." };
  }

  const currentCue = /\b(?:attached|uploaded|sent|provided|current|original)\b/i.test(text)
    || /\bthis\s+(?:image|photo|picture|graphic)\b/i.test(text)
    || /\b(?:image|photo|picture)\s+(?:i|we)\s+(?:sent|uploaded|attached)\b/i.test(text);
  const generatedCue = /\b(?:generated|created|made|designed|edited)\b.{0,48}\b(?:image|photo|picture|graphic|it|one)\b/i.test(text)
    || /\b(?:generate|create|make|design|edit)\b.{0,40}\b(?:image|photo|picture|graphic)\b/i.test(text);
  const requestedIndex = (count: number): number | undefined => {
    if (/\b(?:first|1st)\b/i.test(text)) return count > 0 ? 0 : undefined;
    if (/\b(?:second|2nd)\b/i.test(text)) return count > 1 ? 1 : undefined;
    if (/\b(?:third|3rd)\b/i.test(text)) return count > 2 ? 2 : undefined;
    if (/\b(?:last|latest)\b/i.test(text)) return count > 0 ? count - 1 : undefined;
    return undefined;
  };

  if (currentCue && generatedCue && input.currentCount > 0 && input.generatedCount > 0) {
    return { ambiguous: true, reason: "Both a sent image and a generated image match. Ask which one to use before posting or sending." };
  }
  if (currentCue) {
    const index = requestedIndex(input.currentCount);
    if (index !== undefined) return { source: "current", sourceIndex: index };
    if (input.currentCount === 1) return { source: "current", sourceIndex: 0 };
    if (input.currentCount > 1) return { ambiguous: true, reason: "Several images were sent. Ask which one to use before posting or sending." };
    return { ambiguous: true, reason: "The requested sent image is not available in this run. Ask the user to send it again." };
  }
  if (generatedCue) {
    const index = requestedIndex(input.generatedCount);
    if (index !== undefined) return { source: "generated", sourceIndex: index };
    if (input.generatedCount === 1) return { source: "generated", sourceIndex: 0 };
    if (input.generatedCount > 1) return { ambiguous: true, reason: "Several images were generated. Ask which one to use before posting or sending." };
  }

  const generatedAssets = assets.filter((asset) => asset.tags?.includes("generated") || /generated by chusky/i.test(asset.purpose ?? ""))
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  if (generatedCue && generatedAssets.length) {
    const latest = generatedAssets[0];
    if (generatedAssets.length > 1 && generatedAssets[1]?.createdAt === latest?.createdAt) return { ambiguous: true, reason: "Several saved generated images could match. Ask which one to use before posting or sending." };
    if (latest) return { source: "asset", assetId: latest.id };
  }

  if (input.currentCount > 0 && input.generatedCount > 0) {
    return { ambiguous: true, reason: "Both a sent image and a generated image are available. Ask which one to use before posting or sending." };
  }
  if (input.generatedCount === 1) return { source: "generated", sourceIndex: 0 };
  if (input.generatedCount > 1) return { ambiguous: true, reason: "Several images were generated. Ask which one to use before posting or sending." };
  if (input.currentCount === 1) return { source: "current", sourceIndex: 0 };
  if (input.currentCount > 1) return { ambiguous: true, reason: "Several images were sent. Ask which one to use before posting or sending." };

  if (/\b(?:latest|most recent|newest|last)\b/i.test(text) && assets.length) {
    const latest = newestAsset();
    if (latest) return { source: "asset", assetId: latest.id };
    return { ambiguous: true, reason: "Several saved images could match, and their order is unclear. Ask which image to use before posting or sending." };
  }
  if (assets.length === 1) return { source: "asset", assetId: assets[0]!.id };
  if (assets.length > 1 && /\b(?:saved|previous|earlier|logo|brand)\b/i.test(text)) {
    return { ambiguous: true, reason: "Several saved images could match. Ask which image to use before posting or sending." };
  }
  return { ambiguous: true, reason: "The requested image is not available. Ask the user to attach or select it before posting or sending." };
}

/** Resolve a simple image reference against an image fetched by an owner-scoped
 * native tool earlier in this same run. This is selection context, not action
 * authorization; the request still needs an explicit external media action.
 */
export function selectRetrievedImageForAction(request: string, retrievedAssetIds: readonly string[]): MediaAttachmentSelection | undefined {
  const text = request.trim();
  if (!text
    || !/\b(?:post|publish|share|send|email|attach|include|upload)\b/i.test(text)
    || !/\b(?:it|this|that|these|those)\b/i.test(text)
    || /\b(?:without|exclude|omit|leave out)\b.{0,48}\b(?:image|photo|picture|graphic|visual|attachment|it|that)\b/i.test(text)
    || /\b(?:don't|do not|never)\s+(?:attach|include|send|post|publish|share|upload|email)\b/i.test(text)) return undefined;

  const assetIds = [...new Set(retrievedAssetIds.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 200))];
  if (assetIds.length === 1) return { source: "asset", assetId: assetIds[0]! };
  if (assetIds.length > 1) return { ambiguous: true, reason: "More than one saved image was retrieved for this action. Ask which one to use before posting or sending." };
  return undefined;
}

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
      candidates.push({ path, kind: typeIs(property, "array") ? "array" : "file", description: property.description });
      continue;
    }
    if (typeIs(property, "array") && (property.items as (Schema & { file_uploadable?: boolean }) | undefined)?.file_uploadable === true) {
      candidates.push({ path, kind: "array", description: property.items?.description ?? property.description });
      continue;
    }
    if (typeIs(property, "object")) candidates.push(...findFileUploadCandidates(property, path));
  }
  return candidates;
}

export function hasComposioFileUploadField(inputSchema: unknown): boolean {
  return isObject(inputSchema) && findFileUploadCandidates(inputSchema as Schema).length > 0;
}

function fileUploadCandidateLabel(candidate: FileUploadCandidate): { path: string; description: string } {
  const normalize = (value: string): string => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ");
  return { path: normalize(candidate.path.join(" ")), description: normalize(candidate.description ?? "") };
}

function isVideoUploadCandidate(candidate: FileUploadCandidate): boolean {
  const { path, description } = fileUploadCandidateLabel(candidate);
  return /\b(?:videos?|movies?|clips?)\b/i.test(path) || /\b(?:videos?|movies?|clips?)\b/i.test(description);
}

function imageUploadCandidateScore(candidate: FileUploadCandidate): number {
  const { path, description } = fileUploadCandidateLabel(candidate);
  const imageHint = /\b(?:images?|photos?|pictures?|photographs?)\b/i;
  const thumbnailHint = /\bthumbnails?\b/i;
  const mediaHint = /\b(?:media|attachments?)\b/i;

  // An explicit video label is never a safe target for image bytes, even if
  // another part of the schema description mentions images generically.
  if (isVideoUploadCandidate(candidate)) return 0;
  if (imageHint.test(path)) return 100;
  if (imageHint.test(description)) return 80;
  if (thumbnailHint.test(path)) return 60;
  if (thumbnailHint.test(description)) return 50;
  if (mediaHint.test(path)) return 40;
  if (mediaHint.test(description)) return 30;
  return 0;
}

function selectFileUploadCandidate(inputSchema: unknown, forImage: boolean, preferredFieldPath?: string): FileUploadCandidate {
  if (!isObject(inputSchema)) throw new Error("The selected app action has no usable argument schema.");
  const candidates = findFileUploadCandidates(inputSchema as Schema);
  if (forImage && preferredFieldPath) {
    const preferred = candidates.filter((candidate) => candidate.path.join(".") === preferredFieldPath);
    if (preferred.length === 1) return preferred[0]!;
    throw new Error(`The selected app action does not expose the required image upload field ${preferredFieldPath}.`);
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (!forImage || !isVideoUploadCandidate(only)) return only;
    throw new Error("The selected app action has no schema-declared image upload field.");
  }
  if (!forImage) throw new Error("The selected app action must expose exactly one schema-declared file upload field.");

  const ranked = candidates.map((candidate) => ({ candidate, score: imageUploadCandidateScore(candidate) }));
  const bestScore = Math.max(0, ...ranked.map((item) => item.score));
  const best = ranked.filter((item) => item.score === bestScore && bestScore > 0);
  if (best.length === 1) return best[0]!.candidate;
  throw new Error("The selected app action must expose one unambiguous schema-declared image upload field.");
}

/** Validate an image upload target before staging bytes with Composio. */
export function assertComposioImageUploadField(inputSchema: unknown, preferredFieldPath?: string): void {
  selectFileUploadCandidate(inputSchema, true, preferredFieldPath);
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
  forImage = false,
  preferredFieldPath?: string,
): Record<string, unknown> {
  if (!isObject(inputSchema) || !isObject(actionArguments)) throw new Error("The selected app action has no usable argument schema.");
  const candidate = selectFileUploadCandidate(inputSchema, forImage, preferredFieldPath);
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

function hasBinaryPayload(schema: Schema | undefined): boolean {
  if (!schema) return false;
  if (isObject(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (typeIs(property, "string") && (BINARY_FIELD_NAMES.has(key.toLowerCase()) || /\b(base64|binary|encoded file bytes)\b/i.test(property.description ?? ""))) return true;
      if (hasBinaryPayload(property)) return true;
    }
  }
  return schema.items ? hasBinaryPayload(schema.items) : false;
}

/**
 * Let normal action arguments omit only the image field that Chusky will
 * inject after schema resolution. Every other required field remains checked
 * before the provider action can run.
 */
export function mediaActionPreflightSchema(toolSlug: string, inputSchema: unknown): unknown {
  if (!isObject(inputSchema)) return inputSchema;
  const schema = structuredClone(inputSchema) as Schema & { required?: string[] };
  const paths = [
    ...findFileUploadCandidates(schema).map((candidate) => candidate.path),
    ...findMediaUrlCandidates(schema).map((candidate) => candidate.path),
  ];
  const properties = schema.properties ?? {};
  if (toolSlug === "LINKEDIN_CREATE_LINKED_IN_POST" && typeIs(properties.images, "array") && typeIs(properties.images.items, "string")) paths.push(["images"]);
  if (toolSlug === "TWITTER_CREATION_OF_A_POST") {
    const key = ["media_media_ids", "media_ids", "mediaIds"].find((candidate) => typeIs(properties[candidate], "array") && typeIs(properties[candidate]?.items, "string"));
    if (key) paths.push([key]);
  }
  if (toolSlug === "FACEBOOK_CREATE_PHOTO_POST") {
    const key = Object.entries(properties).find(([name, property]) => /^(photo_id|photoId|media_id|mediaId|photo|media)$/i.test(name)
      && (typeIs(property, "string") || typeIs(property, "array") && typeIs(property.items, "string")))?.[0];
    if (key) paths.push([key]);
  }
  for (const [key, property] of Object.entries(properties)) {
    if (typeIs(property, "string") && (BINARY_FIELD_NAMES.has(key.toLowerCase()) || /\b(base64|binary|encoded file bytes)\b/i.test(property.description ?? ""))) paths.push([key]);
    else if ((typeIs(property, "object") || typeIs(property, "array")) && hasBinaryPayload(property)) paths.push([key]);
  }

  for (const path of paths) {
    let cursor: (Schema & { required?: string[] }) | undefined = schema;
    for (const segment of path.slice(0, -1)) {
      const child = cursor?.properties?.[segment];
      if (!child || !isObject(child.properties)) { cursor = undefined; break; }
      cursor = child as Schema & { required?: string[] };
    }
    if (cursor?.required) cursor.required = cursor.required.filter((key) => key !== path[path.length - 1]);
  }
  return schema;
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
