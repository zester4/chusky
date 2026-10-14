# Chusky Browser TODO

This is the remaining production work for the provider-neutral browser runtime,
the dedicated `chusky-browser` service, and its Chusky integration. The current
browser foundations exist, but a real multi-region warm fleet is not complete
until the deployment and provider-side checks below are finished.

## P0 — cost and safety guardrails before scaling

- [ ] Deploy a staging canary with one Railway region and one browser worker.
- [ ] Set an explicit warm target: start at one warm browser process per region.
- [ ] Set a hard per-worker concurrency limit of 2–4 active sessions.
- [ ] Add a bounded request queue and circuit breaker when worker capacity is full.
- [ ] Add browser-context idle expiry (start with 5–10 minutes) and close unused
      pages, contexts, screenshots, recordings, and live-view resources.
- [ ] Add `BROWSER_WARM_TARGET`, `BROWSER_MAX_SESSIONS_PER_WORKER`,
      `BROWSER_IDLE_TIMEOUT_MS`, region allowlists, and maximum region count to
      validated configuration.
- [ ] Add an operator-controlled monthly usage ceiling and alert thresholds.
- [ ] Review `railway usage` weekly for CPU, RAM, egress, volume, and total cost.
- [ ] Keep Chusky, Redis, and the browser runtime on Railway private networking
      where possible; store large screenshots and recordings in R2 rather than
      Railway volumes.
- [ ] Do not enable three regions or multiple replicas per region until the
      one-region canary has measured attach latency, memory, CPU, egress, and
      challenge rate.

## P1 — dedicated runtime integration

- [ ] Connect Chusky `CHUCK_BROWSER` to the dedicated runtime for start,
      observe, act, verify, stop, reconnect, and same-session handoff.
- [ ] Map the remaining advanced runtime operations: downloads, uploads, popups,
      dialogs, frames, tabs/windows, tracing, recordings, display controls,
      screenshots, and artifact retrieval.
- [ ] Add provider-neutral capability negotiation so E2B, Kernel, and local
      headed Chromium expose only supported operations.
- [ ] Keep Kernel optional: the runtime must operate with E2B or local headed
      Chromium when Kernel is disabled.
- [ ] Add live-view URL brokering with owner scoping, short-lived access,
      revocation, and no raw CDP URL exposure.
- [ ] Verify challenge detection, automatic wait, human handoff, resume, and
      post-challenge outcome verification in the same browser session.
- [ ] Preserve approval gates for payments, purchases, account changes,
      permission changes, and other consequential browser actions.

## P1 — durable session and identity state

- [ ] Replace in-memory session storage in production with Redis or Neon-backed
      durable records.
- [ ] Implement session leases, heartbeats, expiry, reconnect, stale-worker
      recovery, and graceful worker draining.
- [ ] Add a secure session broker that returns opaque session handles instead of
      provider CDP URLs or credentials.
- [ ] Enforce owner/account/profile isolation at every session, artifact, live
      view, and reconnect boundary.
- [ ] Persist encrypted browser profiles with versioning, rotation, restore,
      deletion, and retention limits.
- [ ] Add profile locking so two workers cannot mutate one identity at once.
- [ ] Invalidate element refs after navigation, DOM mutation, frame changes, or
      stale page generations; require a fresh observation before retrying.

## P1 — observability and reliability

- [ ] Emit structured, redacted metrics for session creation, attach latency,
      action latency, observation latency, p50/p95/p99, retries, failures,
      timeouts, reconnects, handoffs, challenge rate, and verified outcomes.
- [ ] Add worker heartbeats, capacity gauges, active leases, queue depth, and
      region health metrics.
- [ ] Add runtime health/readiness endpoints and a separate continuous worker
      heartbeat; Railway deployment healthchecks alone are not continuous
      monitoring.
- [ ] Add trace IDs spanning Chusky, the browser runtime, provider session, and
      artifact/live-view events without logging secrets or private page content.
- [ ] Add bounded retries with jitter only for safe/idempotent operations and
      reconcile uncertain external effects before retrying.

## P2 — warm fleet and regional scheduling

- [ ] Build a durable worker registry containing region, capacity, browser
      version, profile compatibility, health, leases, and drain state.
- [ ] Add a scheduler that prefers the owner-pinned region, then chooses the
      nearest healthy region with available capacity.
- [ ] Keep an active session pinned to its worker/region; reconnect must not
      silently move it to a different browser or identity.
- [ ] Add warm-slot replenishment, crash replacement, controlled draining, and
      deploy coordination.
- [ ] Deploy one region first, then add a second region only after measured
      canary evidence. Use Railway replica/region assignments deliberately.
- [ ] Document the regional data and egress policy, including where profiles,
      screenshots, recordings, and logs are stored.

## P2 — browser quality and benchmark coverage

- [ ] Run real headed Chromium tests against representative public sites with
      navigation, search, forms, scrolling, tabs, frames, downloads, uploads,
      dialogs, popups, and redirects.
- [ ] Run same-session challenge handoff tests; record whether the solver clears
      the challenge or correctly pauses for the owner.
- [ ] Add a 10–20-site benchmark with 3–5 bounded actions per site, verified
      postconditions, screenshots, timings, and failure classification.
- [ ] Compare Kernel, E2B, and local headed Chromium on attach time, action
      success, challenge rate, live-view reliability, and cost.
- [ ] Add regression tests for stale refs, navigation recovery, frame changes,
      browser crashes, CDP disconnects, duplicate actions, and approval pauses.
- [ ] Keep benchmark evidence separate from local unit-test results and clearly
      label provider-side tests that were not run.

## P3 — Railway production release

- [ ] Add the production Docker/Railpack setup for Chrome, Xvfb, Fluxbox,
      noVNC/websockify, fonts, sandbox permissions, and graceful shutdown.
- [ ] Add Railway variables through the dashboard/CLI without committing `.env`
      files, keys, cookies, profiles, or generated artifacts.
- [ ] Configure private service networking, health/readiness checks, resource
      limits, restart policy, and deployment-time smoke tests.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`
      for both the root integration and the dedicated runtime.
- [ ] Perform one live production smoke test with a read-only site, live view,
      screenshot delivery, reconnect, and clean shutdown.
- [ ] Review the Railway usage report after 24 hours and one week before adding
      warm replicas or regions.
- [ ] Publish an operator runbook for deploy, rollback, drain, incident response,
      cost escalation, challenge handoff, and data retention.

## Exit criteria

- [ ] One-region canary is stable, owner-isolated, reconnectable, and budgeted.
- [ ] Kernel can be enabled or disabled without breaking the browser contract.
- [ ] E2B/local headed fallback is verified independently.
- [ ] Live view never exposes raw CDP URLs or cross-account sessions.
- [ ] Every consequential action is approval-gated and every external effect has
      a verifiable result or an honest paused/failed state.
- [ ] Multi-region rollout is backed by measured capacity and Railway usage,
      not assumptions.

## References

- [Railway plans and resource pricing](https://docs.railway.com/pricing/plans)
- [Railway cost-control guidance](https://docs.railway.com/pricing/cost-control)
- [Railway usage inspection](https://docs.railway.com/cli/usage)
- [Railway regions](https://docs.railway.com/deployments/regions)
- [Railway edge networking](https://docs.railway.com/networking/edge-networking)
