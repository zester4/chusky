# Jev decision routing

Chusky uses Jev (TypeSafe's System One decision model) to route each
supervisor turn to the right skills, Composio toolkit/actions, and Treg tools
or endpoints. Jev returns typed answers with calibrated probabilities, not
text. It is a routing proposal only: allowlists, account scope, approval
policy (`src/policy.ts`), idempotency, and Treg spend guards are unchanged.

## Modules

- `src/decisions/jev.ts` — HTTP client (OpenRouter `POST /api/alpha/decisions`
  with `typesafe/jev-1.13`, or TypeSafe `POST /v1/systemone` with
  `jev-1.13.0`), strict answer validation, timeout, circuit breaker,
  `rankOptions` (sharded tournament for large option sets), and
  `verifyCandidates` (parallel Noul multi-label checks).
- `src/decisions/skillRouter.ts` — ranks every installed skill, then verifies
  the top candidates independently so a turn can bind several skills.
  Explicit invocations (`/seo-audit`, "use the pdf skill") always bind.
- `src/decisions/composioRouter.ts` — stage 1: domain, connected toolkit, and
  "needs an app action" in one request. Stage 2: ranks all actions of the
  chosen toolkit(s) (cached catalogue, deprecated actions removed) and
  verifies the top candidates. Confident actions are exposed to the model as
  direct tools with their real Composio schema; the rest are listed in context.
- `src/decisions/tregRouter.ts` — turn-level native Treg tool hint and an
  endpoint judge that replaces the keyword category boost in
  `rankHits()`; price, reliability, latency, input coverage, BYOK/own-account
  filters, and budgets stay deterministic.
- `src/decisions/telemetry.ts` — `jev.shadow` / `jev.enforce` log events with
  identifiers, probabilities, agreement with keyword routing, latency, and
  cost. User text, arguments, and provider payloads are never logged.

## Modes

- `JEV_MODE=off` (default): keyword routing only.
- `JEV_MODE=shadow`: behaviour is unchanged; Jev runs in the background and
  logs agreement with the keyword baseline.
- `JEV_MODE=enforce`: confident Jev routes are applied. Timeouts
  (`JEV_TURN_BUDGET_MS`), HTTP errors, invalid answers, an open breaker, or
  low confidence fall back to keyword routing for that turn.

`JEV_SURFACES` limits routing to `skills`, `composio`, and/or `treg`.

## Rules

- Every Choice includes an explicit `__none__` option; Jev must pick an option.
- Questions in one request cannot see each other; compute dates and numbers
  in code and pass results as state.
- Never let a Jev answer grant approval, widen an allowlist, or bypass spend.
- Never send account aliases, credentials, memories, or tool arguments to
  Jev. State contains the request, bounded recent turns (private runs only),
  and toolkit slugs.
- Tune thresholds from shadow logs, then validate with
  `JEV_MODE=enforce npm run jev:live-smoke`.
