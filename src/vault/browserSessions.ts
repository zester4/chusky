export type BrowserSessionStatus = "authenticated" | "unknown" | "expired" | "logged_out" | "needs_reauth";
export type BrowserSessionRecord = {
  id: string; userId: number; credentialId: string; service: string; origin: string; workspaceId: string;
  status: BrowserSessionStatus; lastAuthenticatedAt?: number; lastUsedAt?: number; expiresAt?: number; createdAt: number; updatedAt: number;
};

export function safeSession(record: BrowserSessionRecord) {
  return { id: record.id, service: record.service, origin: record.origin, workspaceId: record.workspaceId, status: record.status, lastAuthenticatedAt: record.lastAuthenticatedAt, lastUsedAt: record.lastUsedAt, expiresAt: record.expiresAt };
}
