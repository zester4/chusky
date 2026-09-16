import { leaseVaultCredential, recordVaultSession } from "./vault.js";
import type { BrowserPlaybookRecord } from "./browserOps.js";

export type TrustedBrowserLogin = { workspaceId?: (userId: number) => Promise<string>; login(userId: number, input: { origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string; loginRecipe?: BrowserPlaybookRecord["login"] }): Promise<{ workspaceId: string; authenticated: boolean; needsUserInteraction?: boolean }> };

/** The only secret-bearing operation in Railway. Its return value is always secret-free. */
export async function loginWithVault(userId: number, service: string, browser: TrustedBrowserLogin, accountAlias = "default", origin?: string, loginRecipe?: BrowserPlaybookRecord["login"]) {
  const workspaceId = browser.workspaceId ? await browser.workspaceId(userId) : "pending";
  const credential = await leaseVaultCredential(userId, service, workspaceId, accountAlias, origin);
  const secret = { username: credential.username, password: credential.password };
  try {
    const result = await browser.login(userId, { ...credential, ...secret, ...(loginRecipe ? { loginRecipe } : {}) });
    const status = result.needsUserInteraction ? "awaiting_user_interaction" : result.authenticated ? "authenticated" : "needs_reauth";
    const session = await recordVaultSession(userId, { credentialId: credential.id, service: credential.service, accountAlias: credential.accountAlias, origin: credential.origin, workspaceId: result.workspaceId, status, lastAuthenticatedAt: result.authenticated ? Date.now() : undefined, lastUsedAt: Date.now() });
    return { authenticated: result.authenticated, service: credential.service, origin: credential.origin, session, needsUserInteraction: Boolean(result.needsUserInteraction) };
  } finally {
    secret.username = ""; secret.password = "";
    credential.username = ""; credential.password = "";
  }
}
