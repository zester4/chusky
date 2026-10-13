# Browser control plane

Chusky’s browser control plane is provider-neutral at the session boundary and
provider-specific at the browser-process boundary.

## Session lifecycle

`BrowserSessionManager` owns the common lifecycle contract:

- `acquire` chooses a registered provider and compatible region, reuses an
  owner/profile-compatible warm session when available, and issues a bounded
  owner lease.
- `renew`, `reconnect`, and `release` operate on the opaque `br_...` lease.
- `execute` applies the shared browser action policy and records latency/failure
  telemetry around the action.
- `adoptExternalLease` bridges retained E2B/Kernel sessions that are created by
  the existing `E2BBrowserEngine`.

Providers implement `BrowserProviderAdapter`; they own Chromium startup,
shutdown, and reconnect details. The manager never assumes that E2B, Kernel,
Playwright, or Agent Browser is the browser itself.

## Warm sessions and regions

`WarmBrowserSessionPool` stores only opaque provider session IDs and scheduling
metadata. It does not store CDP URLs, cookies, page content, screenshots, or
credentials. A pool entry is matched by owner, provider, region, profile, and
capabilities. A provider must register a warm session explicitly; the current
retained E2B path remains the source of truth when no adapter pool is
configured.

## CDP and profile boundaries

`CdpSessionBroker` keeps raw `ws:`/`wss:` CDP URLs in trusted process memory and
returns only short-lived, owner-bound `cdp_...` tickets. Raw CDP URLs must stay
inside the provider adapter and must never be returned by a tool or persisted in
browser state.

`EncryptedBrowserProfileStore` provides AES-256-GCM envelopes for persistent
profile state. The envelope is account-bound and rejects a different owner or
an expired profile. Kernel-managed profiles remain provider-owned; this store
is for providers that need Chusky-side encrypted profile metadata.

## Ref safety and metrics

`BrowserRefRegistry` binds a ref to the owner, lease, URL, observation ID, and
page generation. Navigation or DOM regeneration invalidates the ref and forces
fresh inspection. The existing E2B node checks remain authoritative for
`CHUCK_BROWSER` actions; the registry is the shared primitive for adapters and
future browser surfaces.

`BrowserMetrics` keeps bounded aggregate samples only. It reports attach,
reconnect, action, and challenge counts, failures, averages, p50/p95 latency,
and challenge rate. E2B/Kernel health output includes the aggregate snapshot;
no URLs, text, refs, credentials, or screenshots are retained in metrics.

## Policy

`actionPolicy.ts` is the single browser policy table used by both the manager
and the vault guard. Routine browse/search actions can proceed in an authorized
private run. Checkout, purchase, account changes, uploads, and sensitive
downloads require the existing explicit approval path; password/email changes
and account deletion remain blocked.
