import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getMigrations } from "better-auth/db/migration";

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
test("installed Better Auth migrates MFA and completes enrollment and sign-in challenges locally", async () => {
  const database = new Database(":memory:");
  const auth = betterAuth({
    database, secret: "local-test-only-auth-secret-at-least-32-characters",
    baseURL: "http://localhost:8080", trustedOrigins: ["http://localhost:3000"],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    plugins: [twoFactor({ issuer: "Chusky", backupCodeOptions: { storeBackupCodes: "encrypted" } })],
    rateLimit: { enabled: false },
  });
  const cookies = new Map<string, string>();
  const headers = () => new Headers({ Origin: "http://localhost:3000", Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") });
  async function request(path: string, body: unknown) {
    const sent = headers(); sent.set("Content-Type", "application/json");
    const response = await auth.handler(new Request(`http://localhost:8080/api/auth/${path}`, { method: "POST", headers: sent, body: JSON.stringify(body) }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";"); const index = pair.indexOf("=");
      const name = pair.slice(0, index); const value = pair.slice(index + 1);
      if (!value || /Max-Age=0/i.test(cookie)) cookies.delete(name); else cookies.set(name, value);
    }
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  try {
    await (await getMigrations(auth.options)).runMigrations();
    const credentials = { email: "builder@example.test", password: "test-password-012345" };
    assert.equal((await request("sign-up/email", { ...credentials, name: "Builder" })).status, 200);
    const enrollment = await request("two-factor/enable", { password: credentials.password });
    assert.equal(enrollment.status, 200);
    assert.ok(Array.isArray(enrollment.body.backupCodes));
    const secret = new URL(String(enrollment.body.totpURI)).searchParams.get("secret")!;
    assert.equal((await auth.api.getSession({ headers: headers(), query: { disableCookieCache: true } }))?.user.twoFactorEnabled, false);
    assert.equal((await request("two-factor/verify-totp", { code: totp(secret), trustDevice: false })).status, 200);
    const session = await auth.api.getSession({ headers: headers(), query: { disableCookieCache: true, disableRefresh: true } });
    assert.equal(session?.user.twoFactorEnabled, true);
    // Verify the exact server API used by the builder step-up endpoint.
    await auth.api.verifyTOTP({ headers: headers(), body: { code: totp(secret), trustDevice: false } });
    await request("sign-out", {}); cookies.clear();
    const login = await request("sign-in/email", credentials);
    assert.equal(login.status, 200);
    assert.equal(login.body.twoFactorRedirect, true);
    assert.equal(await auth.api.getSession({ headers: headers() }), null);
    const valid = totp(secret); const invalid = String((Number(valid[0]) + 1) % 10) + valid.slice(1);
    assert.equal((await request("two-factor/verify-totp", { code: invalid })).status, 401);
    assert.equal((await request("two-factor/verify-totp", { code: valid, trustDevice: false })).status, 200);
    assert.ok((await auth.api.getSession({ headers: headers() }))?.session.token);
  } finally { database.close(); }
});
