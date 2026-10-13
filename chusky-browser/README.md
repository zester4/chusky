# Chusky Browser

An agent-native browser control plane for reliable, observable, human-safe web work.

This folder is an intentionally provider-neutral scaffold. It is not a second
Playwright wrapper and it is not a CAPTCHA bypass. The core owns the difficult
parts that should remain stable while the underlying browser changes:

- structured observation before every decision;
- fast screenshot planning with visual escalation only when it adds signal;
- stable control identity across SPA re-renders and frame changes;
- bounded action execution with independent postcondition verification;
- challenge detection, automatic-solver waiting, and same-session handoff;
- origin, approval, credential, and owner-scope boundaries;
- redacted traces, replay metadata, and benchmarkable evidence.

The current Chusky implementation remains the production integration. This
folder is the extraction point for a future standalone browser product. The
first implementation slice is deliberately dependency-light so its state
machine and safety contracts can be tested without opening a live browser.

## What this is designed to become

```text
agent goal
    |
    v
task policy -----> provider router -----> E2B / Kernel / Playwright-CDP / harness
    |                    |
    |                    +--> capability-aware action path
    v
observe packet <----- session manager <----- profile / auth / live handoff
    |
    +--> accessibility + DOM controls + URL/title + screenshot evidence
    |
    v
bounded action -> independent verification -> checkpoint / trace / next step
```

The design uses the strongest path available for each moment rather than
forcing every website through pixels or every website through selectors:

1. semantic controls and page state for speed and determinism;
2. Playwright/CDP for frames, downloads, network-aware waits, and DOM work;
3. viewport screenshots for layout, custom widgets, overlays, and visual proof;
4. native computer controls for the small set of interactions that require
   OS-level input or produce bot-sensitive automation signals;
5. private human takeover for CAPTCHA, MFA, passkeys, age checks, or approval.

## Run the scaffold

From the repository root, the current checkout already has `tsx` installed:

```powershell
node_modules\.bin\tsx --test "chusky-browser/tests/*.test.ts"
```

For standalone use:

```powershell
Set-Location "chusky-browser"
npm install
npm test
npm run typecheck
```

There are no provider credentials or live browser calls in this scaffold.
That is intentional: credentials stay in the host application, and live
provider certification belongs in explicit smoke and benchmark jobs.

## Status

Implemented here:

- typed provider/session/observation/action contracts;
- screenshot and structured-observation planning;
- bounded orchestration loop with progress detection;
- recovery classification that refuses blind consequential retries;
- same-session challenge wait/handoff contract;
- safe-origin and approval classification helpers;
- bounded redacted trace sink;
- capability-ranked routing without provider-name branches;
- event-driven tab/frame target registry with navigation generations;
- visual evidence budgets and escalation decisions;
- provider circuit breaker with a single half-open probe;
- benchmark cases that score verified evidence separately from completion claims;
- focused contract tests for all of the above.

Still integration work:

- Kernel, E2B, Playwright-CDP, and browser-harness adapters;
- durable Chusky checkpoint/event persistence;
- live-view delivery through owner-private channels;
- provider smoke matrix and site-independent benchmark runner;
- optional image crop/thumbnail service and trace artifact retention.

## Live proof in this checkout

The host application has an explicit disposable Kernel/E2B smoke path. With the
existing environment configured, run:

```powershell
npm run kernel:browser:check -- --live
npm run kernel:browser:complex
```

The first check proves provider creation, a public navigation, observation,
live-view availability, and cleanup. The complex check additionally exercises a
real React SPA observation, Selenium's public multi-field form and submitted
state, tab creation/closure, diagnostics, screenshot evidence, and cleanup.
It intentionally does not claim CAPTCHA, managed-auth, or iframe success.

Read [docs/RESEARCH.md](docs/RESEARCH.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
and [docs/ROADMAP.md](docs/ROADMAP.md) before moving code into a standalone
repository.
