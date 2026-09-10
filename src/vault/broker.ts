import { leaseVaultCredential, recordVaultSession } from "./vault.js";

export type TrustedBrowserLogin = { login(userId: number, input: { origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string }): Promise<{ workspaceId: string; authenticated: boolean; needsUserInteraction?: boolean }> };

/** The only secret-bearing operation in Railway. Its return value is always secret-free. */
export async function loginWithVault(userId: number, service: string, browser: TrustedBrowserLogin) {
  const credential = await leaseVaultCredential(userId, service, "pending");
  const secret = { username: credential.username, password: credential.password };
  try {
    const result = await browser.login(userId, { ...credential, ...secret });
    const status = result.needsUserInteraction ? "awaiting_user_interaction" : result.authenticated ? "authenticated" : "needs_reauth";
    const session = await recordVaultSession(userId, { credentialId: credential.id, service: credential.service, origin: credential.origin, workspaceId: result.workspaceId, status, lastAuthenticatedAt: result.authenticated ? Date.now() : undefined, lastUsedAt: Date.now() });
    return { authenticated: result.authenticated, service: credential.service, origin: credential.origin, session, needsUserInteraction: Boolean(result.needsUserInteraction) };
  } finally {
    secret.username = ""; secret.password = "";
    credential.username = ""; credential.password = "";
  }
}
