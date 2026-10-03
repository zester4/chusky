import type { BrowserProvider, BrowserRuntime } from "./types.js";

export type BrowserRuntimeFactory = (options?: Record<string, unknown>) => BrowserRuntime;

const factories = new Map<BrowserProvider, BrowserRuntimeFactory>();

export function registerBrowserRuntime(provider: BrowserProvider, factory: BrowserRuntimeFactory): void {
  if (!provider || typeof factory !== "function") throw new Error("A browser runtime provider and factory are required");
  factories.set(provider, factory);
}

export function createBrowserRuntime(provider: BrowserProvider, options?: Record<string, unknown>): BrowserRuntime {
  const factory = factories.get(provider);
  if (!factory) throw new Error(`Browser runtime provider is not configured: ${provider}`);
  return factory(options);
}

export function listBrowserRuntimeProviders(): BrowserProvider[] { return [...factories.keys()]; }
