# Private builder control plane

The first builder release lives at the frontend's `/admin` route and the
cookie-only backend `/builder/v1` routes. It is separate from customer
organizations, onboarding, developer project keys, and the existing root-key
`/v1/admin` API. No root key is sent to the browser.

## Enable after deployment

1. Run `npm run auth:migrate` with the existing direct
   `BETTER_AUTH_MIGRATION_DATABASE_URL` before deploying the new auth config.
   Better Auth adds its two-factor and admin-user-management schema; existing
   accounts are preserved. This is a deliberate production migration, not a
   startup DDL operation.
2. Set `CHUSKY_BUILDER_ADMIN_IDS` to a comma-separated list of existing,
   verified Better Auth user IDs. Optional `CHUSKY_BUILDER_VIEWER_IDS`
   grants read-only access. Do not use emails or organization IDs.
3. Enable `CHUSKY_BUILDER_ADMIN_ENABLED=true`. Redis, Better Auth, and the
   existing exact trusted frontend origins must be configured.
4. Deploy the backend and frontend together, then sign in and open `/admin`.
   Enroll an authenticator, save recovery codes, verify enrollment, and enter
   a current authenticator code to unlock the control plane.

This release does not automatically configure Railway or run production
migrations. Builder access is denied by default when the allowlist is empty.

## What works

- Live configuration-presence checks without secret values, provider URLs,
  customer histories, or raw error messages.
- Existing application storage telemetry and Neon schema/reachability checks.
- Failure counters and process uptime, explicitly labeled as process-local.
- Builder roles with `view_metrics` and `manage_flags` permissions.
- The People view lists bounded Better Auth account metadata through the
  server-side Admin plugin. It never returns passwords, sessions, memories,
  provider data, or secret values. The same immutable builder allowlist is used
  by the Admin plugin; the dashboard still requires MFA step-up before calling
  the endpoint.
- Workspace invitations continue to use Better Auth's organization invitation
  flow from the customer workspace. The builder console links to that flow
  instead of creating a second invitation system.
- Authenticator verification bound to a hashed session token for 15 minutes.
  Expired, revoked, impersonated, unverified, or unallowlisted sessions cannot
  enter. Mutations also require a session created within the last 15 minutes.
- Pause/resume of shared `runAgent` execution before new model turns and tool
  dispatch. Local controls refresh immediately after a write; other replicas
  observe changes during active work within a five-second cache window.
- Version-checked changes and audit entries saved together by Redis Lua.
  Redis retains the most recent 1,000 events; the audit view returns 100.
  Reason codes are bounded enums; no arbitrary secrets/configuration can be
  submitted through this API.
- Manual refresh; no background dashboard polling or idle control polling.
  Concurrent execution checks share one cached read. Redis outages fail closed
  when builder execution controls are enabled.

## Operational limits

Already-dispatched provider work cannot be recalled by a pause. Direct SDK
provider endpoints, delivery/recovery workers, and externally executing jobs
are not covered by this agent pause. It is an agent-execution control, not a
provider-wide cancellation or billing kill switch.

Storage telemetry is not Upstash/Neon billing and may omit auth Redis traffic.
Configuration presence is not a live provider certification. Durable audit
export/long-term retention, per-provider/channel switches, global queue
inspection, and deployment/secret rotation are future work. Runtime feature
flags must be added as explicit allowlisted controls; Railway environment
variables and secrets are intentionally not editable from the browser.

Disabling the builder feature in Railway bypasses its runtime controls and
restores the previous agent behavior; it is an operator rollback mechanism.
No scheduled process or database-wide scan is introduced by this release.

Tests verify deny paths, permissions, origin checks, MFA/session binding,
concurrent changes, stale-read invalidation, and outage handling. The installed
Better Auth 1.7.x two-factor migration/enrollment/sign-in flow is exercised
against an isolated in-memory SQLite database, never production Neon.
