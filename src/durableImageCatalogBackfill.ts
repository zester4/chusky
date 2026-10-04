import type { ImageAsset } from "./store.js";

export type ImageCatalogBackfillRejection =
  | "invalid_owner"
  | "invalid_asset"
  | "owner_mismatch"
  | "invalid_asset_id"
  | "invalid_key"
  | "unsupported_content_type"
  | "extension_mismatch"
  | "invalid_size";

const imageExtensions: Record<ImageAsset["contentType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Accept only an exact owner-scoped manifest entry; never infer ownership from an R2 listing. */
export function validateImageCatalogBackfillCandidate(
  ownerUserId: number,
  candidate: unknown,
  maxBytes: number,
): ImageCatalogBackfillRejection | undefined {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return "invalid_owner";
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return "invalid_asset";
  const asset = candidate as Partial<ImageAsset>;
  if (asset.userId !== ownerUserId) return "owner_mismatch";
  if (typeof asset.id !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(asset.id)) return "invalid_asset_id";
  if (typeof asset.r2Key !== "string" || !asset.r2Key.startsWith(`images/${ownerUserId}/`)
    || asset.r2Key.includes("..") || asset.r2Key.includes("\\") || asset.r2Key.includes("\u0000")) return "invalid_key";
  if (typeof asset.contentType !== "string" || !Object.hasOwn(imageExtensions, asset.contentType)) return "unsupported_content_type";
  const extension = imageExtensions[asset.contentType as ImageAsset["contentType"]];
  if (!extension) return "unsupported_content_type";
  if (!asset.r2Key.endsWith(`.${extension}`)) return "extension_mismatch";
  if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxBytes) return "invalid_size";
  return undefined;
}
