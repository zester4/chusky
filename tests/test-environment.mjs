import { fileURLToPath } from "node:url";

// src/config.ts imports dotenv/config as a module side effect. Point dotenv at
// a committed empty file before any test module loads so local .env credentials
// cannot silently turn a unit/contract test into a live provider call.
process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL("./empty.env", import.meta.url));
process.env.TELEGRAM_BOT_TOKEN = "ci-test-telegram-token";
process.env.COMPOSIO_API_KEY = "ci-test-composio-key";
process.env.OPENROUTER_API_KEY = "ci-test-openrouter-key";

// These tests are local by default. The crash proof may opt into its separate,
// explicitly isolated MISSION_PROCESS_REDIS_URL; it never inherits REDIS_URL.
for (const key of [
  "REDIS_URL",
  "UPSTASH_VECTOR_REST_URL",
  "UPSTASH_VECTOR_REST_TOKEN",
  "QSTASH_TOKEN",
  "QSTASH_URL",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "BETTER_AUTH_DATABASE_URL",
  "DURABLE_STATE_DATABASE_URL",
  "DURABLE_MEMORY_DATABASE_URL",
]) {
  delete process.env[key];
}

// Contract and unit tests must not make accidental internet calls with dummy
// credentials. Keep loopback available for tests that exercise local HTTP.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const url = new URL(rawUrl);
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return nativeFetch(input, init);
  throw new Error("External network access is disabled in the test environment.");
};
