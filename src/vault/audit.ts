import { createHash } from "node:crypto";

export type VaultAuditEvent = "credential_saved" | "credential_listed" | "login_started" | "login_succeeded" | "login_failed" | "session_checked" | "session_logged_out" | "policy_blocked";
export type VaultAuditEntry = { userId: number; event: VaultAuditEvent; service?: string; credentialId?: string; sessionId?: string; metadata?: Record<string, unknown> };

/** Never pass credentials or raw browser arguments here. Values are deliberately key-only metadata. */
export function redactVaultAudit(entry: VaultAuditEntry) {
  return {
    userHash: createHash("sha256").update(String(entry.userId)).digest("hex"), event: entry.event,
    service: entry.service, credentialId: entry.credentialId, sessionId: entry.sessionId,
    metadata: Object.fromEntries(Object.entries(entry.metadata ?? {}).map(([key, value]) => [key, typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "[redacted]"])),
  };
}
