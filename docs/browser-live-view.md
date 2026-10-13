# Chusky browser live view

Chusky runs browser actions in the retained owner-scoped E2B session. E2B can
run headed Chrome for Testing, and Kernel can host a headed Chromium session
with its own live-view endpoint. The live-view feature is the delivery layer
between that provider session and a user who wants to watch or take over.

## Runtime contract

- `CHUCK_BROWSER` with `action=stream_start` creates a live viewer for an
  owner-private run. The default `mode` is `read-only`.
- `action=stream_start, mode=interactive` is reserved for an explicit human
  handoff. `CHUCK_BROWSER_HANDOFF` uses interactive mode automatically.
- When `WEBHOOK_URL` is a safe public HTTPS origin, Chusky returns
  `/browser/live/<encrypted-ticket>`. The page embeds the provider view and
  applies a read-only pointer boundary unless the ticket is interactive.
- The ticket contains the provider target only inside authenticated encryption.
  The durable browser record stores a second encrypted envelope, never a raw
  provider URL. `stream_status` can therefore reissue the active watch link
  after a process restart without putting the provider URL in model context or
  durable state in plaintext.
- `stream_stop` clears the owner’s active Chusky viewer and revokes the
  Chusky-hosted URL. E2B services are stopped too. Kernel's provider URL is
  controlled by Kernel and remains valid until the Kernel browser ends; use the
  normal browser `stop` action when provider-level revocation is required.

## Configuration

Set `WEBHOOK_URL` to the public HTTPS origin of the Chusky API and set
`CHUSKY_BROWSER_LIVE_VIEW_SECRET` to a stable server-only random value. If the
dedicated key is blank, the implementation falls back to `CHUSKY_PROJECT_KEY`
and then `WEBHOOK_SECRET` for compatibility. Do not expose any of these values
to browser JavaScript or model tool arguments.

If `WEBHOOK_URL` is missing or unsafe, the runtime returns the provider's own
live URL as a development fallback. Provider URLs are bearer credentials: do
not log them, store them in chat history, or place them in public pages.

## Why this follows the provider model

Browserbase documents on-demand session live-view URLs, per-tab URLs, iframe
embedding, and a disconnect event. Browserless documents reconnectable watched
sessions and warns that session identifiers must not expose unrelated sessions.
E2B documents its public URLs as reachable by anyone who knows the URL and
therefore treats them as credentials. Kernel's browser live view is similarly
session-scoped and provider-owned. Chusky combines those lessons by making the
viewer lifecycle owner-scoped and revocable at the Chusky boundary while
leaving video/control transport with the browser provider.

Official references:

- [Browserbase session live view](https://docs.browserbase.com/platform/browser/observability/session-live-view)
- [Browserbase live-view URL API](https://docs.browserbase.com/reference/api/session-live-urls)
- [Browserless watching sessions](https://docs.browserless.io/enterprise/watching-sessions)
- [E2B public URL security](https://e2b.dev/docs/network/public-url)
- [E2B remote browser and Kernel live view](https://e2b.mintlify.app/docs/use-cases/remote-browser)
- [Vercel agent-browser](https://github.com/vercel-labs/agent-browser)

This is not an authentication replacement for a signed-in product dashboard:
the Chusky URL is still a short-lived bearer handoff for the person who has it.
The owner binding prevents a ticket from being replayed against a different
active Chusky stream, and revocation prevents new access through Chusky.
