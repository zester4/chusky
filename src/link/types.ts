import type { EncryptedCredential } from "../vault/crypto.js";

export type LinkWalletStatus = "connected" | "reauth_required" | "disconnected";

export interface LinkWalletRecord {
  userId: number;
  status: LinkWalletStatus;
  scopes: string[];
  encryptedTokens: EncryptedCredential;
  expiresAt: number;
  linkUserId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LinkOAuthStateRecord {
  state: string;
  redirectUri: string;
  encryptedSecret: EncryptedCredential;
  createdAt: number;
  expiresAt: number;
}

export type LinkSpendStatus =
  | "created"
  | "pending_approval"
  | "approved"
  | "expired"
  | "denied"
  | "submitted"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requires_action"
  | "uncertain";

export interface LinkSpendRequestRecord {
  id: string;
  userId: number;
  providerId?: string;
  status: LinkSpendStatus;
  merchantName: string;
  merchantUrl: string;
  amount: number;
  currency: string;
  context: string;
  approvalUrl?: string;
  credentialType?: "card" | "shared_payment_token";
  cardBrand?: string;
  cardLast4?: string;
  linkTransactionId?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export type LinkWalletTokens = Record<string, unknown> & {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt: number;
  scope?: string;
};
