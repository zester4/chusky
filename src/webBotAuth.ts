import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { createSignature, component, type RequestDescriptor, type ResponseDescriptor } from "http-message-sig";
import { config } from "./config.js";

export const WEB_BOT_AUTH_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";

type Ed25519Jwk = { kty: "OKP"; crv: "Ed25519"; d: string; x: string; alg: "EdDSA" };

export type WebBotAuthStatus = "disabled" | "configured" | "misconfigured";

export type WebBotAuthDirectory = {
  body: string;
  headers: Record<string, string>;
};

function directoryUrl(): URL | undefined {
  try {
    const url = new URL(config.webBotAuthDirectoryUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== WEB_BOT_AUTH_DIRECTORY_PATH) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function privateJwk(): Ed25519Jwk | undefined {
  const encoded = config.webBotAuthPrivateKeyB64.replace(/\s/g, "");
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  try {
    const key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    const jwk = key.export({ format: "jwk" }) as unknown as { kty?: string; crv?: string; d?: string; x?: string };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) return undefined;
    return { kty: "OKP", crv: "Ed25519", alg: "EdDSA", d: jwk.d, x: jwk.x };
  } catch {
    return undefined;
  }
}

export function webBotAuthConfigurationStatus(): WebBotAuthStatus {
  if (!config.webBotAuthEnabled && config.webBotAuthSignRequests) return "misconfigured";
  if (!config.webBotAuthEnabled) return "disabled";
  return directoryUrl() && privateJwk() ? "configured" : "misconfigured";
}

export function webBotAuthConfigurationIssue(): string | undefined {
  if (!config.webBotAuthEnabled && config.webBotAuthSignRequests) return "WEB_BOT_AUTH_SIGN_REQUESTS requires WEB_BOT_AUTH_ENABLED=true";
  if (!config.webBotAuthEnabled) return undefined;
  if (!directoryUrl()) return "WEB_BOT_AUTH_DIRECTORY_URL must be an HTTPS URL ending in /.well-known/http-message-signatures-directory";
  if (!privateJwk()) return "WEB_BOT_AUTH_PRIVATE_KEY_B64 must be a valid base64-encoded Ed25519 PKCS#8 DER private key";
  return undefined;
}

export function webBotAuthSigningEnabled(): boolean {
  return config.webBotAuthEnabled && config.webBotAuthSignRequests && webBotAuthConfigurationStatus() === "configured";
}

export function webBotAuthKeyId(): string | undefined {
  const jwk = privateJwk();
  if (!jwk) return undefined;
  // RFC 7638 thumbprints require this canonical member order for OKP keys.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function webBotAuthSandboxEnvironment(): Record<string, string> {
  if (!webBotAuthSigningEnabled()) return {};
  return {
    CHUSKY_WEB_BOT_AUTH_DIRECTORY_URL: directoryUrl()!.toString(),
    CHUSKY_WEB_BOT_AUTH_PRIVATE_KEY_B64: config.webBotAuthPrivateKeyB64.replace(/\s/g, ""),
  };
}

export async function createSignedWebBotAuthDirectory(requestUrl: string): Promise<WebBotAuthDirectory> {
  const canonicalUrl = directoryUrl();
  const jwk = privateJwk();
  if (!config.webBotAuthEnabled || !canonicalUrl || !jwk) throw new Error("Web Bot Auth is not configured");

  let incoming: URL;
  try { incoming = new URL(requestUrl); } catch { throw new Error("Invalid directory request URL"); }
  // TLS may terminate at the hosting proxy, so validate the externally
  // configured authority/path without trusting the app-server URL scheme.
  if (incoming.host !== canonicalUrl.host || incoming.pathname !== WEB_BOT_AUTH_DIRECTORY_PATH || incoming.search || incoming.hash) {
    throw new Error("Directory request does not match the configured HTTPS origin");
  }

  const now = Math.floor(Date.now() / 1_000);
  const privateKey = createPrivateKey({ key: Buffer.from(config.webBotAuthPrivateKeyB64.replace(/\s/g, ""), "base64"), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }) as unknown as { kty?: string; crv?: string; x?: string };
  if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || !publicKey.x) throw new Error("Web Bot Auth public-key derivation failed");

  const body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: publicKey.x }] });
  const request: RequestDescriptor = {
    kind: "request",
    method: "GET",
    targetUri: canonicalUrl.toString(),
    fields: [{ name: "host", value: canonicalUrl.host }],
  };
  const response: ResponseDescriptor = { kind: "response", status: 200, fields: [], request };
  const signed = await createSignature(response, {
    label: "sig1",
    components: [component("@authority", { req: true })],
    parameters: {
      alg: "ed25519",
      keyid: webBotAuthKeyId()!,
      created: now,
      expires: now + 60,
      nonce: randomBytes(64).toString("base64"),
      tag: "http-message-signatures-directory",
    },
    signer: {
      algorithm: "ed25519",
      sign: (data) => cryptoSign(null, Buffer.from(data), privateKey),
    },
  });

  return {
    body,
    headers: {
      "content-type": WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE,
      "cache-control": "no-store",
      signature: signed.signature,
      "signature-input": signed.signatureInput,
    },
  };
}
