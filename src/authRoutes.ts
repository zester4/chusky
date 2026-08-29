import { cors } from "hono/cors";
import type { Hono } from "hono";
import { config } from "./config.js";
import { getAuth } from "./auth.js";

export function registerAuthRoutes(app: Hono): void {
  app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
  app.use("/api/auth/*", cors({ origin: (origin) => origin && config.betterAuthTrustedOrigins.includes(origin) ? origin : "", credentials: true, allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.all("/api/auth/*", (c) => {
    if (!config.betterAuthEnabled) return c.json({ error: "authentication is not configured" }, 503);
    return getAuth().handler(c.req.raw);
  });
}
