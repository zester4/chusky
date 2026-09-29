export type BrowserRequestHeader = { name: string; value: string };
export type BrowserRequestForSigning = { url: string; method: string; headers: BrowserRequestHeader[] };
export type WebBotAuthSigningOptions = {
  signer: { algorithm: string; sign(data: Uint8Array): Uint8Array | Promise<Uint8Array> };
  keyId: string;
  directoryUrl: string;
  now?: Date;
  generateNonce?: () => string;
};
export function createWebBotAuthHeaders(request: BrowserRequestForSigning, options: WebBotAuthSigningOptions): Promise<BrowserRequestHeader[]>;
