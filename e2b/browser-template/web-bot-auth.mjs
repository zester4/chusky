import { createSignature, component } from "http-message-sig";
import { randomBytes } from "node:crypto";

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const SIGNATURE_HEADERS = new Set(["signature", "signature-input", "signature-agent"]);

/** Sign one Chromium request hop. Call once per CDP Fetch pause, including redirects. */
export async function createWebBotAuthHeaders(request, options) {
  const url = new URL(request.url);
  const directory = new URL(options.directoryUrl);
  if (url.protocol !== "https:" || directory.protocol !== "https:" || directory.pathname !== DIRECTORY_PATH || directory.username || directory.password || directory.search || directory.hash) {
    throw new Error("Web Bot Auth requires HTTPS and a canonical directory URL");
  }
  const headers = request.headers
    .filter((header) => !SIGNATURE_HEADERS.has(header.name.toLowerCase()))
    .map(({ name, value }) => ({ name, value: String(value) }));
  const signatureAgent = `"${directory.toString()}"`;
  const descriptor = {
    kind: "request",
    method: request.method,
    targetUri: url.toString(),
    fields: [...headers, { name: "signature-agent", value: signatureAgent }],
  };
  const now = options.now ?? new Date();
  const created = Math.floor(now.getTime() / 1_000);
  const fields = await createSignature(descriptor, {
    label: "sig1",
    components: [component("@authority"), component("signature-agent")],
    parameters: {
      alg: "ed25519",
      keyid: options.keyId,
      created,
      expires: created + 60,
      nonce: (options.generateNonce ?? (() => randomBytes(64).toString("base64")))(),
      tag: "web-bot-auth",
    },
    signer: options.signer,
  });
  return [
    ...headers,
    { name: "Signature-Agent", value: signatureAgent },
    { name: "Signature-Input", value: fields.signatureInput },
    { name: "Signature", value: fields.signature },
  ];
}
