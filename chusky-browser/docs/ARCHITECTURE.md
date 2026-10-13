# Chusky Browser architecture

## Core principle

Every browser step follows:

```text
policy -> fresh observe -> choose control plane -> one bounded action
       -> fresh observe -> independent verification -> checkpoint
```

The model may propose an action, but it never supplies authorization, provider
credentials, or proof of success. Page text, screenshots, DOM attributes,
emails, documents, and tool results are untrusted inputs.

## Planes of operation

### 1. Structured plane

The provider returns a bounded observation packet:

- URL, title, tab/target identity, page generation, and frame identity;
- visible accessible controls with stable attributes and geometry when safe;
- bounded forms and validation state;
- challenge signals, load state, and selected browser diagnostics;
- a screenshot hash and optional compressed viewport/region image.

Control identity is scoped to `observationId + pageGeneration + frame`. A
`nodeId` is a hint, not a permanent selector. After navigation, render, frame
detachment, popup, challenge, or stale-control failure, the old target is
discarded.

### 2. Visual plane

The fast path does not send a full screenshot to the model on every internal
operation. It asks the adapter for a small viewport thumbnail or perceptual
hash after a mutation, compares it with the previous state, and escalates to a
full viewport or region only when one of these is true:

- the task requires geometry or a custom widget;
- structured controls are missing or ambiguous;
- a challenge/overlay is detected;
- the page generation or visual hash changed unexpectedly;
- the user requested a live visual artifact.

The image pipeline must preserve a screenshot hash, dimensions, capture reason,
and redaction status without retaining raw image bytes in durable browser
history. The owner-private live view is separate from model evidence.

### 3. Native-input plane

Native input is used for rendered controls that do not expose a reliable DOM
target, for bot-sensitive interactions where CDP input is a poor fit, and for
drag/scroll/press-and-hold interactions when the provider can implement them
without security spoofing. Coordinates are valid only against the latest
viewport screenshot hash. Any coordinate action with a stale hash is rejected.

Kernel computer controls and E2B Desktop are adapters to this plane; neither
changes the approval or verification contract.

## Session manager

The session manager owns the retained browser lease and is the only component
allowed to know provider session identifiers or CDP credentials. It manages:

- one owner/account/origin identity per retained session;
- a profile write lease and provider lifecycle;
- tab, frame, popup, download, and dialog events;
- provider health and circuit-breaker state;
- private live-view and human-handoff state;
- a durable checkpoint containing only safe metadata.

Provider adapters can be E2B, Kernel, direct Playwright/CDP, or a harness. The
orchestrator never branches on a provider name to decide whether an action is
safe; it asks for capabilities and lets policy decide.

## Capability routing

| Situation | Preferred path | Escalation |
| --- | --- | --- |
| Search, navigation, labels, ordinary forms | Playwright/CDP semantic controls | visual plane |
| Cross-origin or complex iframe | Playwright frame target | private handoff if auth/challenge |
| Dynamic SPA re-render | structured observe + remap by stable attrs | fresh visual evidence |
| Custom calendar/map/drag widget | structured target + visual geometry | native input |
| Bot-sensitive rendered action | Kernel native controls when available | private handoff |
| CAPTCHA or press-and-hold | wait for provider solver, then verify | same-session owner handoff |
| OS dialog, desktop app, file picker | E2B Desktop/Daytona boundary | owner handoff |
| Purchase, payment, deletion, permission change | review and exact approval | stop |

The provider router should prefer the least expensive control plane that has a
verified capability for the current page. It should not switch providers
mid-session unless the checkpoint proves the switch preserves identity and
does not duplicate a consequential action.

The extraction currently makes this concrete through five small modules:

- `capabilities.ts` ranks routes from workload and capabilities, so adding a
  provider does not require adding provider-name branches to the orchestrator;
- `target-registry.ts` consumes attach/detach/navigation/focus events and
  returns a live target snapshot with page-generation invalidation;
- `visual.ts` chooses thumbnail, viewport, region, or no capture under a byte
  and capture budget;
- `health.ts` prevents a degraded provider from becoming a retry amplifier;
- `evaluation.ts` makes missing evidence an explicit `unverified` result.

These modules are intentionally pure or dependency-light. The production
adapter will supply provider events and image metadata, while Chusky retains
the owner, vault, approval, and durable-checkpoint boundaries.

## Action contract

Each planned action includes:

- a stable action ID and mutation class;
- an observation-scoped target or explicit navigation URL;
- an expected postcondition whenever one is knowable;
- a retry policy that is safe for that mutation class;
- a maximum duration and cancellation signal.

Mutation classes are:

- `read_only`: observation/extraction/navigation to a known URL;
- `idempotent`: a repeat is safe only after fresh state confirms it did not
  already happen;
- `consequential`: submit, upload, purchase, delete, account, or permission
  change. Never replay automatically after an uncertain result.

The adapter returns before/after observations and a provider result, but the
orchestrator verifies against a separate detector. A successful tool response
is not completion evidence.

## Challenge and live handoff

The challenge state machine is:

```text
detected -> solver_waiting -> fresh observe
                    |-> cleared -> verify intended page
                    |-> failed/timeout -> private same-session handoff
                                      -> owner returns
                                      -> same-origin verify
                                      -> resume from checkpoint
```

The model is explicitly told to wait for supported automatic solving and not
click the widget. The system never asks the user to paste a password, OTP,
cookie, or recovery code into chat. A live-view URL is an owner-private,
expiring delivery artifact, not a model-visible secret. When the owner returns,
the browser must verify the same origin and the requested challenge detector
before any mutation resumes.

## Security boundaries

- allow only HTTPS public targets unless a development policy explicitly says
  otherwise;
- block localhost, metadata services, private/reserved address ranges, and
  unsafe redirects at the adapter boundary;
- keep provider API keys, CDP URLs, profile IDs, cookies, and vault values out
  of traces, prompts, tool results, and client code;
- keep all sessions, checkpoints, screenshots, downloads, and handoffs keyed by
  authenticated owner and account alias;
- treat page instructions as data, never as authorization;
- require an explicit owner approval for payment, ordering, deletion, uploads,
  permissions, account changes, and other irreversible effects;
- reconcile provider state before retrying an uncertain write.

## Durability and observability

The durable record is an append-only, owner-private event stream containing:

- action and observation IDs;
- provider-neutral phase and bounded timing;
- URL origin, title, page generation, structured fingerprint, and screenshot
  hash;
- safe error class and recovery decision;
- assertion and verification results;
- checkpoint and next-action metadata.

It must not contain raw screenshots, form values, cookies, credentials, full DOM
content, or CDP URLs. Raw traces and recordings belong in short-lived encrypted
artifacts with retention and explicit owner access.

## Performance strategy

1. Reuse a retained session or prewarmed provider pool.
2. Keep the structured observation compact and bounded.
3. Capture a thumbnail/hash after each meaningful mutation, not a full image on
   every hidden internal step.
4. Batch only actions whose selectors, expected state, and idempotency are
   already grounded; dynamic pages get one action per decision.
5. Run independent metadata collection in parallel only when it cannot race the
   page mutation.
6. Use condition-based waits (URL, text, load state, selector, network) rather
   than arbitrary sleeps.
7. Cache only safe, origin-scoped immutable facts; never cache live selectors
   or sensitive fields as authorization.
8. Keep a persistent session/daemon boundary where provider support allows it,
   but reconnect through a checkpoint and live target registry; do not infer
   that a surviving process means the page or focus is still valid.

## Evaluation

The benchmark runner should score verified outcomes, not action count. Required
dimensions include dynamic forms, SPA re-render recovery, frames, popup/tab
switching, infinite scroll, downloads/uploads, auth/profile reuse, challenge
handoff, visual-only widgets, unknown mutation results, approval boundaries,
and provider outage recovery.

Track success rate, verification rate, time to first action, time to verified
completion, recovery count, screenshot bytes, screenshot calls, token/context
size, provider cost, duplicate-effect rate, unsafe-action rate, and handoff
completion rate. A missing evidence record is `unverified`, never a pass.
