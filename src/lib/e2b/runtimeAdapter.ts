import type { BrowserActionStep, BrowserRuntime } from "../browser-runtime/types.js";
import type { E2BBrowserEngine } from "./browser.js";

/** Adapts the existing E2B engine to the provider-neutral browser contract. */
export function createE2BBrowserRuntime(engine: Pick<E2BBrowserEngine, "browser">, ownerPrivateRun = true): BrowserRuntime {
  const call = (ownerId: number, args: Record<string, unknown>) => engine.browser(ownerId, args, { ownerPrivateRun });
  return {
    provider: "e2b",
    async observe(ownerId, options = {}) { return await call(ownerId, { action: "observe", ...options }) as never; },
    async act(ownerId, step: BrowserActionStep) { return await call(ownerId, { action: "act", step }) as Record<string, unknown>; },
    async extract(ownerId, schema: Record<string, unknown>) { return await call(ownerId, { action: "extract", schema }) as Record<string, unknown>; },
    async run(ownerId, steps: BrowserActionStep[], options = {}) { return await call(ownerId, { action: "agent", steps, ...options }) as Record<string, unknown>; },
  };
}
