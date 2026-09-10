import { createHash, createHmac, randomUUID } from "node:crypto";
import { config } from "../config.js";

export type VaultSetupRequest = { service: string; origin: string; loginUrl?: string; logoutUrl?: string; usernameFieldLabel?: string; passwordFieldLabel?: string; submitButtonLabel?: string };
export type VaultSession = { id: string; service: string; origin: string; workspaceId: string; status: "authenticated" | "unknown" | "expired" | "logged_out" | "needs_reauth" | "awaiting_user_interaction"; lastAuthenticatedAt?: number; lastUsedAt?: number; expiresAt?: number };
export type VaultCredentialMetadata = { id: string; service: string; origin: string; loginUrl: string; session?: VaultSession };
export type VaultLease = { credential: { id: string; service: string; origin: string; loginUrl: string; usernameFieldLabel: string; passwordFieldLabel: string; submitButtonLabel: string; username: string; password: string } };

export class VaultBrokerClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  constructor(baseUrl = config.vaultBrokerUrl, secret = config.vaultBrokerHmacSecret) { this.baseUrl = baseUrl.replace(/\/+$/, ""); this.secret = secret; }
  enabled(): boolean { return Boolean(config.vaultEnabled && this.baseUrl.startsWith("https://") && this.secret.length >= 32); }
  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.enabled()) throw new Error("Vault is unavailable. Configure VAULT_ENABLED=true, VAULT_BROKER_URL, and VAULT_BROKER_HMAC_SECRET.");
    const payload = JSON.stringify(body); const timestamp = String(Date.now()); const nonce = randomUUID(); const requestId = randomUUID();
    const digest = createHash("sha256").update(payload).digest("hex");
    const signature = createHmac("sha256", this.secret).update(`POST\n${path}\n${timestamp}\n${nonce}\n${digest}`).digest("base64url");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "x-chusky-timestamp": timestamp, "x-chusky-nonce": nonce, "x-chusky-signature": signature, "x-chusky-request-id": requestId }, body: payload });
      const result = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) throw new Error(result.error || `Vault broker request failed (${response.status})`);
      return result;
    } finally { clearTimeout(timeout); }
  }
  beginSetup(accountId: string, request: VaultSetupRequest) { return this.request<{ service: string; origin: string; expiresAt: number; setupUrl: string }>("/v1/setup", { accountId, ...request }); }
  list(accountId: string) { return this.request<{ credentials: VaultCredentialMetadata[] }>("/v1/list", { accountId }); }
  status(accountId: string, service?: string) { return this.request<{ sessions: VaultSession[] }>("/v1/status", { accountId, service }); }
  lease(accountId: string, service: string, workspaceId: string) { return this.request<VaultLease>("/v1/lease", { accountId, service, workspaceId }); }
  recordSession(accountId: string, input: Omit<VaultSession, "id"> & { credentialId: string }) { return this.request<{ session: VaultSession }>("/v1/session", { accountId, ...input }); }
  logout(accountId: string, service: string) { return this.request<{ service: string; status: string; note: string }>("/v1/logout", { accountId, service }); }
}
export const vaultBroker = new VaultBrokerClient();
