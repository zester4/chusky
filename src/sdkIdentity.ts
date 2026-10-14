import { createHash } from "node:crypto";

/** Preserve existing digests while accepting legacy plain request fingerprints. */
export function canonicalSdkFingerprint(value: string): string {
  return /^[a-f0-9]{32,128}$/.test(value) ? value : createHash("sha256").update(value).digest("hex");
}

/**
 * Derive the stable internal owner ID used for an authenticated SDK subject.
 * Keep this in one shared module so linked-account reconciliation and request
 * authentication use the exact same namespace and hash contract.
 */
export function stableSdkUserId(externalId: string, projectId: string): number {
  return Number.parseInt(createHash("sha256").update(`sdk:${projectId}:${externalId}`).digest("hex").slice(0, 12), 16);
}
