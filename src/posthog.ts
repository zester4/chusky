import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_API_KEY ?? "";
const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

// Singleton PostHog client. Shared across all request handlers in this process.
// Uses flushAt=20/flushInterval=5000 (defaults) so the background flush loop
// batches events efficiently for a long-running server. Call posthog.shutdown()
// on process exit to drain any remaining queued events.
export const posthog: PostHog | null = apiKey
  ? new PostHog(apiKey, {
      host,
      // Errors are captured explicitly at monitored boundaries so prompts and
      // provider payloads are never collected by a global uncaught-exception hook.
      enableExceptionAutocapture: false,
    })
  : null;
