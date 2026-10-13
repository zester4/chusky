# Roadmap

## Phase 0 — contracts and proof boundaries (implemented in this scaffold)

- provider-neutral contracts;
- structured/visual observation planner;
- bounded action loop;
- recovery classifier and no-blind-retry policy;
- challenge wait/handoff contract;
- redacted trace sink;
- capability-ranked route selection;
- event-driven target registry;
- visual evidence budgets;
- provider circuit breaker;
- benchmark evidence scoring;
- unit tests at the orchestrator and adapter seams.

## Phase 1 — extract the Chusky runtime

- implement an adapter over the existing E2B controller;
- map existing `CHUCK_BROWSER_*` observations/actions into the new contracts;
- map E2B `forms`, `matches`, `tabs`, frame metadata, screenshot hashes,
  diagnostics, and checkpoint fields into the provider-neutral packet;
- preserve current owner isolation, vault, approval, handoff, and checkpoint
  behavior;
- add contract tests that run both the old and new adapter paths against the
  same fixtures;
- keep the existing stable tool slugs and provider boundary.

## Phase 2 — make the provider router real

- Kernel adapter with Playwright/CDP and computer controls;
- browser-harness adapter for persistent CDP sessions and low-latency helpers;
- capability probing and a per-session circuit breaker;
- provider selection based on task, page signals, and available capabilities;
- one-session handoff between structured and native input planes.

## Phase 3 — live evidence and speed

- thumbnail/perceptual hash service;
- screenshot crops around candidate controls and changed regions;
- viewport and full-page capture budgets;
- Playwright trace-on-failure and provider replay links;
- streaming progress events with private live-view URLs;
- prewarmed pools and safe profile leases.

## Phase 4 — benchmark-driven reliability

- a deterministic local fixture suite for forms, iframes, SPAs, popups,
  downloads, overlays, and challenge screens;
- opt-in public smoke sites with no account or payment side effects;
- recorded provider certification for E2B and Kernel;
- failure injection for stale targets, target crashes, network errors, timeouts,
  challenge failures, and unknown mutation outcomes;
- record live evidence separately for stable public pages and unstable target
  classes such as cross-origin iframes;
- regression gates on verified success, duplicate-effect rate, unsafe-action
  rate, and evidence completeness.

## Phase 5 — standalone repository

- split the core package from Chusky transport adapters;
- publish provider adapters as optional packages;
- add a private session service and encrypted artifact store;
- add an SDK for task plans, observation packets, and verified outcomes;
- add a policy extension point for organizations without allowing policy to be
  supplied by page content or the model.

## Release gates

No phase is “done” because a browser opened. A release requires:

1. focused contract tests;
2. typecheck and build;
3. provider live smoke with cleanup proof;
4. benchmark evidence with explicit unverified cases;
5. security review for secrets, owner scope, network targets, and approvals;
6. a read-back or independent postcondition for every consequential flow.
