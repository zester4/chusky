# Jev decision routing

Chusky uses Jev (TypeSafe's System One decision model) to route supervisor
turns and to propose bounded autonomous decisions. Jev returns typed answers
with calibrated probabilities, not text. It is a proposal only: allowlists,
account scope, approval policy (`src/policy.ts`), idempotency, verification,
and Treg spend guards are unchanged.

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
- `src/autonomy/decisionLoop.ts` — typed autonomy decisions for next-action
  planning, attention-pulse priority, mission progression, signal triage,
  follow-up timing/channel, memory retention, delegation, and failure recovery.
  It validates every proposal against deterministic authority before a caller
  may execute or persist anything.

## Modes

- `JEV_MODE=off` (default): keyword routing only.
- `JEV_MODE=shadow`: existing routing is unchanged and Jev comparison
  telemetry is recorded for the established routing surfaces. Autonomy uses
  its deterministic proposal path until `enforce`, so proactive work cannot
  acquire new behavior during shadow rollout.
- `JEV_MODE=enforce`: confident Jev routes are applied. Timeouts, HTTP
  errors, invalid answers, an open breaker, or low confidence fall back to
  keyword routing for that turn.

Skill, Treg, Composio, and autonomy routing (including the connected-account lookup)
start together and share one per-turn deadline (`JEV_TURN_BUDGET_MS`). Its
signal aborts in-flight Jev and catalogue requests, so routing adds at most
that budget to the critical path. Deadline aborts do not open the breaker.

Jev is additive. A Jev answer, including a confident `__none__`, never
removes keyword skill routes or the keyword Composio domain route. Fuzzy
skill search stays available unless the user explicitly selected a skill.

`JEV_SURFACES` limits routing to `skills`, `composio`, `treg`, and/or
`autonomy`. `JEV_MODE=off` disables every Jev surface and preserves the
deterministic behavior used before Jev. Autonomy decisions are applied only
in `enforce`; `shadow` and `off` preserve the existing runtime path. Autonomy
calls are only made for durable/proactive work; ordinary chat does not incur
an autonomy decision call.

## Rules

- Every Choice includes an explicit `__none__` option; Jev must pick an option.
- Questions in one request cannot see each other; compute dates and numbers
  in code and pass results as state.
- Never let a Jev answer grant approval, widen an allowlist, or bypass spend.
- The typed autonomy loop is `observe -> prioritize -> choose next action ->
  validate authority -> execute -> verify -> update loop`. Jev proposes the
  middle decisions; the durable mission/task/pulse runtime performs and
  verifies the work.
- Never send account aliases, credentials, memories, or tool arguments to
  Jev. State contains the request, bounded recent turns (private runs only),
  and toolkit slugs.
- Tune thresholds from shadow logs, then validate with
  `JEV_MODE=enforce npm run jev:live-smoke`.
