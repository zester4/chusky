import { generateKeyPairSync, createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

const outputPath = path.resolve(process.cwd(), ".web-bot-auth.env");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const jwk = publicKey.export({ format: "jwk" });
if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new Error("Could not derive an Ed25519 public JWK");
const thumbprintInput = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
const keyId = createHash("sha256").update(thumbprintInput).digest("base64url");

async function main(): Promise<void> {
  const contents = [
    "# Keep this local file private; do not commit or send it in chat.",
    "WEB_BOT_AUTH_ENABLED=true",
    "WEB_BOT_AUTH_SIGN_REQUESTS=false",
    "WEB_BOT_AUTH_DIRECTORY_URL=https://your-chusky-domain/.well-known/http-message-signatures-directory",
    `WEB_BOT_AUTH_PRIVATE_KEY_B64=${privateKeyB64}`,
    "",
  ].join("\n");

  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  console.log(`Generated a new Ed25519 Web Bot Auth identity at ${outputPath}`);
  console.log(`Public key thumbprint (keyid): ${keyId}`);
  console.log("The private key was not printed. Keep the file private and copy its variable value directly into Railway Secret settings.");
}

main().catch((error: unknown) => {
  console.error("Web Bot Auth key generation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
