import { cors } from "hono/cors";
import type { Hono } from "hono";
import { config } from "./config.js";
import { getAuth } from "./auth.js";
import { posthog } from "./posthog.js";

export function registerAuthRoutes(app: Hono): void {
  app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
  app.use("/api/auth/*", cors({ origin: (origin) => origin && config.betterAuthTrustedOrigins.includes(origin) ? origin : "", credentials: true, allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  // Capture sign-in events. Read the body before delegating; clone the request
  // to avoid consuming the stream so Better Auth can still read it.
  app.use("/api/auth/sign-in/email", async (c, next) => {
    const cloned = c.req.raw.clone();
    await next();
    if (c.res.status === 200) {
      const body = await cloned.json().catch(() => ({})) as { email?: string };
      const email = typeof body.email === "string" ? body.email : "";
      // Use a stable hash of the email as the distinct ID — never the raw email.
      if (email) {
        const { createHash } = await import("node:crypto");
        const distinctId = createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
        posthog?.capture({ distinctId, event: "user_signed_in", properties: { provider: "email" } });
      }
    }
  });
  app.all("/api/auth/*", (c) => {
    if (!config.betterAuthEnabled) return c.json({ error: "authentication is not configured" }, 503);
    return getAuth().handler(c.req.raw);
  });
}
