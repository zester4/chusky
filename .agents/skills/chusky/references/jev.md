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
- `src/decisions/composioRouter.ts` — stage 1 (parallel): domain and
  "needs an app" triage, plus a ranking of every connected toolkit and, with
  `JEV_COMPOSIO_ROUTE_UNCONNECTED=true`, Composio's full toolkit catalogue
  (connected apps are marked and preferred when they can do the job). Stage 2:
  ranks all actions of the chosen toolkit(s) (cached catalogue, deprecated
  actions removed) and verifies the top candidates. Confident actions on
  connected apps are exposed as direct tools with their real schema. A routed
  app that is not connected yields a connect-first hint (call
  `COMPOSIO_MANAGE_CONNECTIONS`, then continue); its actions are listed but
  never executable until connected.
- `src/decisions/tregRouter.ts` — turn-level native Treg tool hint and an
  endpoint judge that scores task fit (synchronous, asynchronous, and bulk
  endpoints are equally valid; mode is described neutrally) and replaces the
  keyword category boost in `rankHits()`; price, reliability, latency, input coverage, BYOK/own-account
  filters, and budgets stay deterministic.
- `src/decisions/telemetry.ts` — `jev.shadow` / `jev.enforce` log events with
  identifiers, probabilities, agreement with keyword routing, latency, and
  cost. User text, arguments, and provider payloads are never logged.

## Modes

- `JEV_MODE=off` (default): keyword routing only.
- `JEV_MODE=shadow`: behaviour is unchanged; Jev runs in the background and
  logs agreement with the keyword baseline.
- `JEV_MODE=enforce`: confident Jev routes are applied. Timeouts, HTTP
  errors, invalid answers, an open breaker, or low confidence fall back to
  keyword routing for that turn.

Skill, Treg, and Composio routing (including the connected-account lookup)
start together and share one per-turn deadline (`JEV_TURN_BUDGET_MS`). Its
signal aborts in-flight Jev and catalogue requests, so routing adds at most
that budget to the critical path. Deadline aborts do not open the breaker.

Jev is additive. A Jev answer, including a confident `__none__`, never
removes keyword skill routes or the keyword Composio domain route. Fuzzy
skill search stays available unless the user explicitly selected a skill.

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
