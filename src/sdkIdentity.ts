import { createHash } from "node:crypto";

/**
 * Derive the stable internal owner ID used for an authenticated SDK subject.
 * Keep this in one shared module so linked-account reconciliation and request
 * authentication use the exact same namespace and hash contract.
 */
export function stableSdkUserId(externalId: string, projectId: string): number {
  return Number.parseInt(createHash("sha256").update(`sdk:${projectId}:${externalId}`).digest("hex").slice(0, 12), 16);
}
