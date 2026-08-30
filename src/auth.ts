import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { redisStorage } from "@better-auth/redis-storage";
import Redis from "ioredis";
import { config } from "./config.js";
import { sendAuthEmail } from "./auth-email.js";

// The Redis storage package and Better Auth core currently expose separate
// structural versions of the same SecondaryStorage type. Keep that adapter
// compatibility boundary local rather than weakening the rest of the service.
let instance: any;
let redis: Redis | undefined;
let postgres: Pool | undefined;
let sqlite: Database.Database | undefined;
let migration: Promise<void> | undefined;

type AuthDatabase = Database.Database | Pool;

function createDatabase(): AuthDatabase {
  const databaseUrl = config.betterAuthDatabaseUrl;
  if (process.env.NODE_ENV === "production" && !databaseUrl) {
    throw new Error("BETTER_AUTH_DATABASE_URL must be configured in production; use Neon Postgres instead of local SQLite.");
  }
  if (databaseUrl) return postgres = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  mkdirSync(dirname(resolve(config.betterAuthDatabasePath)), { recursive: true });
  return sqlite = new Database(config.betterAuthDatabasePath);
}

function authConfig(database: AuthDatabase) {
  if (process.env.BETTER_AUTH_ENABLED !== "true") throw new Error("Better Auth is disabled; set BETTER_AUTH_ENABLED=true");
  const secret = process.env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const baseURL = (process.env.BETTER_AUTH_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");
  const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || "http://localhost:3000,http://localhost:3010")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });

  return {
    // Better Auth accepts both pg.Pool and better-sqlite3 as built-in Kysely adapters.
    database: database as any,
    secret,
    baseURL,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: process.env.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION !== "false",
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        await sendAuthEmail("password-reset", { email: user.email, name: user.name, url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        await sendAuthEmail("verification", { email: user.email, name: user.name, url });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60,
    },
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      storage: redis ? "secondary-storage" as const : "memory" as const,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
      },
    },
    advanced: {
      disableCSRFCheck: false,
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: { sameSite: "lax" as const, httpOnly: true },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    ...(redis ? { secondaryStorage: redisStorage({ client: redis, keyPrefix: "better-auth:" }) as any } : {}),
  };
}

export function getAuth() {
  if (!instance) instance = betterAuth(authConfig(createDatabase()));
  return instance;
}

export async function initAuth(): Promise<void> {
  // Neon pooled application connections should not run DDL migrations. Use the
  // explicit auth:migrate command with BETTER_AUTH_MIGRATION_DATABASE_URL.
  if (postgres) { await postgres.query("SELECT 1"); return; }
  if (!migration) {
    const configured = getAuth();
    migration = getMigrations(configured.options).then(({ runMigrations }) => runMigrations());
  }
  await migration;
}

/** Run Better Auth migrations against Neon's direct, non-pooler connection. */
export async function migrateAuthDatabase(): Promise<void> {
  const migrationUrl = config.betterAuthMigrationDatabaseUrl;
  if (!migrationUrl) throw new Error("BETTER_AUTH_MIGRATION_DATABASE_URL must be set to Neon's direct connection string before running auth migrations.");
  const migrationPool = new Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const migrationAuth = betterAuth(authConfig(migrationPool));
    const { runMigrations } = await getMigrations(migrationAuth.options);
    await runMigrations();
  } finally {
    await migrationPool.end();
  }
}

// Better Auth's CLI discovers a named `auth` export. Keep the export lazy for
// the existing auth-disabled polling mode, while enabled deployments and the
// migration CLI receive the configured instance.
export const auth = process.env.BETTER_AUTH_ENABLED === "true" ? getAuth() : undefined;

export async function closeAuth(): Promise<void> {
  if (redis) { await redis.quit().catch(() => undefined); redis = undefined; }
  if (postgres) { await postgres.end().catch(() => undefined); postgres = undefined; }
  if (sqlite) { sqlite.close(); sqlite = undefined; }
  instance = undefined;
}
