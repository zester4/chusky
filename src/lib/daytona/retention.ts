import type { ArtifactRetention, ArtifactVisualDiffRecord } from "../../store.js";

export function retentionFromSeconds(value: unknown, now = Date.now()): ArtifactRetention {
  if (value === undefined || value === null || value === "") return { mode: "forever", policyName: "owner-retained" };
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 365 * 24 * 60 * 60) {
    throw new Error("retentionSeconds must be an integer from 60 seconds to 365 days");
  }
  return { mode: "ttl", expiresAt: now + seconds * 1000, policyName: "owner-requested-ttl" };
}

export function visualDiffStatus(previousFingerprint: string | undefined, fingerprint: string): ArtifactVisualDiffRecord["status"] {
  if (!previousFingerprint) return "baseline";
  return previousFingerprint === fingerprint ? "unchanged" : "changed";
}

export function isExpired(retention: ArtifactRetention, now = Date.now()): boolean {
  return retention.mode === "ttl" && typeof retention.expiresAt === "number" && retention.expiresAt <= now;
}
