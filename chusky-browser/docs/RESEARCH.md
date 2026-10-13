# Browser platform research

Research date: 2026-10-13. Sources were selected from the official Kernel,
E2B, Microsoft Playwright, and browser-use documentation or source
repositories. Provider behavior is version-sensitive; the installed package
and a live smoke test remain authoritative before production activation.

## Findings that change the design

### Kernel is a browser execution substrate, not the whole agent

Kernel's browser exposes multiple control planes over one browser session:

- Playwright execution in the browser VM for low-latency deterministic work;
- CDP/WebDriver attachment when a local client or harness is needed;
- computer controls for OS-level mouse, keyboard, scrolling, dragging, and
  screenshots;
- headful sessions, live view, replay, profiles, browser pools, proxies, and
  managed authentication.

The important design implication is a capability router. Playwright should be
the default for semantic, frame-aware, and verification-heavy actions. Native
computer controls should be an explicit escalation when a website's rendered
surface is the source of truth or CDP activity is itself a problem. A single
agent loop should be able to switch control planes without losing the session
or checkpoint.

Sources: [Kernel browser creation](https://www.kernel.sh/docs/introduction/create),
[Kernel computer controls](https://www.kernel.sh/docs/browsers/computer-controls),
[Kernel bot detection overview](https://www.kernel.sh/docs/browsers/bot-detection/overview).

### Stealth improves conditions; it is not a success guarantee

Kernel documents anti-detection defaults and an opt-in stealth mode that adds a
managed ISP proxy and an automatic CAPTCHA solver. Profiles and browser pools
provide consistency across visits, which is often more valuable than changing
the automation API. The docs also describe GPU-backed rendering and human-like
native input as anti-detection signals.

The product must therefore report `solver_waiting`, `challenge_cleared`,
`challenge_failed`, and `human_handoff_required` separately. A provider saying
that a solver ran is not evidence that the page reached the intended state.
The agent prompt should tell the model to wait and re-observe rather than click
the challenge widget itself.

Source: [Kernel stealth mode](https://www.kernel.sh/docs/browsers/bot-detection/stealth).

### Profiles are an identity primitive with a write-concurrency rule

Kernel profiles persist cookies and local storage and can be shared across
sites through managed auth connections. `save_changes` is a write operation;
parallel writers to one profile can corrupt or unpredictably overwrite state.
The browser layer must map one owner and account alias to a profile, lease
profile writes, and keep the profile immutable for read-only runs.

Sources: [Kernel profiles](https://www.kernel.sh/docs/auth/profiles),
[Kernel authentication overview](https://www.kernel.sh/docs/auth/overview).

### E2B is useful as an isolated controller and desktop boundary

E2B's official material positions Desktop as a sandboxed virtual desktop with
screen streaming for computer-use agents. Its SDK and templates are also a
natural place to run Playwright and trusted controller code inside an isolated
environment. That separation is valuable: the host application owns policy,
credentials, approvals, and durable state while the sandbox owns browser
execution.

The control plane should not leak a CDP URL, raw credentials, screenshots, or
unbounded page content into model context. Live view and downloadable artifacts
need the same owner-scoped and time-limited boundary as the browser session.

Sources: [E2B computer use](https://docs.e2b.dev/use-cases/computer-use),
[E2B JavaScript SDK](https://docs.e2b.dev/sdk-reference/js-sdk),
[E2B Playwright cookbook](https://github.com/e2b-dev/e2b-cookbook/tree/main/examples/playwright-in-e2b).

### Playwright has more agent leverage than “click a selector”

The current Playwright surface gives us role/name locators, auto-waiting,
web-first assertions, ARIA snapshots, frames, downloads, CDP connection,
screenshots, and traces with before/action/after DOM snapshots and screenshots.
Playwright MCP demonstrates a structured accessibility-first model interface;
Playwright CLI demonstrates a token-efficient command/skill interface for
coding agents.

The browser should combine these strengths rather than choose screenshots or
DOM exclusively:

- accessibility and DOM snapshots are the fast control plane;
- screenshot thumbnails are a cheap visual change detector;
- full viewport or region captures are requested only for ambiguity, geometry,
  challenge evidence, or user-visible proof;
- traces are diagnostic artifacts, not model context by default.

Sources: [Playwright locator API](https://playwright.dev/docs/api/class-locator),
[Playwright trace viewer](https://playwright.dev/docs/trace-viewer),
[Playwright MCP](https://github.com/microsoft/playwright-mcp),
[Playwright](https://playwright.dev/).

### Browser-use shows the value of persistent CDP sessions and reusable helpers

Browser-use's open-source agent and browser-harness emphasize a persistent
browser session, direct CDP attachment, editable helpers, screenshots on
demand, and an event-driven target/session manager. The useful lesson is not
to copy a framework wholesale; it is to make session identity and target
lifecycle first-class. A tab or frame can disappear while the browser remains
healthy, so the session manager must rebuild focus from current CDP target
state rather than reuse a stale locator.

Sources: [browser-use](https://github.com/browser-use/browser-use),
[browser-harness](https://github.com/browser-use/browser-harness).

## Capability matrix

| Capability | E2B controller | Kernel | Playwright/CDP | Browser harness | Product decision |
| --- | --- | --- | --- | --- | --- |
| Isolated cloud execution | strong | provider-managed | depends on host | depends on host | keep behind adapter |
| Semantic DOM controls | strong | via Playwright/CDP | strong | strong | default decision path |
| Native mouse/keyboard | desktop boundary | strong computer controls | limited to browser input | CDP/browser dependent | explicit visual escalation |
| Stealth/proxy/CAPTCHA solver | no generic guarantee | first-class managed option | host dependent | provider dependent | wait, verify, handoff |
| Persistent auth state | host/profile boundary | profiles + managed auth | storage state | profile/session dependent | owner/account lease |
| Live view | E2B stream/handoff | Kernel live view | host dependent | cloud/local dependent | same-session private URL |
| Replays/traces | controller/artifact path | replays + Playwright traces | Playwright traces | recordings/helpers | bounded evidence only |
| Low-latency repeated control | sandbox command path | in-VM Playwright / CDP | direct local | persistent daemon | session reuse + batching |

This matrix is an architecture guide, not a provider SLA. “Supported” means
the source documents describe the capability, not that every target website
will accept it.

## What we will not build

- CAPTCHA or anti-fraud bypasses that spoof a user or defeat site policy;
- blind selector replay after a re-render;
- screenshot-only control for every action;
- raw page dumps or secret values in model context;
- automatic retries for purchases, submissions, uploads, deletions, or unknown
  mutation outcomes;
- a promise that stealth makes every website automation-friendly.

## Research conclusions

The next step is not “add more screenshots.” It is a control plane that keeps
structured state, visual evidence, native input, session identity, provider
capabilities, and verification in one loop. The novel leverage is the ability
to switch among those planes at action granularity while preserving a single
checkpoint and a single safety policy.

## Additional research: where the strongest browser agents get leverage

The current research pass also compared the production-facing ideas in
Stagehand, Vercel's agent-browser, and Browserless. These are useful patterns,
not reasons to copy a provider API into Chusky:

- Stagehand separates `observe`, `act`, and `extract`. An observed action can
  be replayed directly without re-running inference, and its self-heal path is
  bounded to a re-inference/retry. Its experimental batch context shows where
  round trips can be removed, but the docs explicitly warn that a batch is not
  atomic; Chusky therefore batches only already-grounded, non-consequential
  work.
- Vercel's agent-browser makes the daemon/session boundary first-class: compact
  accessibility snapshots, stable tab labels, explicit frame switching,
  semantic waits, network routes, console/errors, tracing, recording, and
  profiler hooks. Chusky adopts the useful separation between fast model
  context and deep diagnostics, while keeping raw traces out of prompts.
- Browserless demonstrates a reconnectable session: a browser can remain alive
  while a controller process changes, then reconnect through CDP within a
  bounded TTL. Chusky's checkpoint and target registry are designed for the
  same failure mode, but reconnect must preserve owner scope and must never
  replay an uncertain mutation.
- Browser-use/browser-harness reinforces the event-driven target lifecycle:
  pages, frames, workers, focus, and detachment are state transitions, not
  static handles. The new target registry turns that insight into a small
  provider-neutral seam with page-generation invalidation.

Sources: [Stagehand reference](https://docs.stagehand.dev/v4/reference/stagehand),
[Stagehand configuration](https://docs.stagehand.dev/v4/configuration/browser),
[agent-browser repository](https://github.com/vercel-labs/agent-browser),
[agent-browser commands](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/commands.md),
[Browserless standard sessions](https://docs.browserless.io/baas/session-management/standard-sessions).

## What was implemented from the research

The scaffold now contains five explicit seams that can be wired to the existing
Chusky browser without changing the stable `CHUCK_BROWSER` contract:

| Research leverage | Chusky Browser seam | Safety boundary |
| --- | --- | --- |
| capability-aware control planes | `src/capabilities.ts` | unhealthy or under-capable providers are excluded |
| event-driven pages/frames/tabs | `src/target-registry.ts` | detached targets disappear; navigation increments generation |
| cheap visual context plus escalation | `src/visual.ts` | capture count and bytes are budgeted |
| reconnect/provider degradation | `src/health.ts` | one half-open probe; no retry storm |
| verified benchmark culture | `src/evaluation.ts` | completion without evidence is unverified |

This is deliberately more ambitious than adding screenshot calls, but it is
still an extraction layer: the live Chusky E2B/Kernel runtime remains the
authority for credentials, owner scope, approvals, handoff, and provider
cleanup.

## Live provider evidence from this checkout

The disposable Kernel/E2B baseline passed: public navigation, fresh
observation, screenshot evidence, private live-view availability, and cleanup.
The complex smoke passed the stable cases for React SPA observation, a public
Selenium multi-field form submitted through the form planner with independent
`submitted-form.html` / `Received!` verification, tab creation/closure,
diagnostics, screenshot evidence, and cleanup. A third-party iframe target was
not counted: its navigation hung and was terminated/cleaned up, so frame support
remains a locally tested contract rather than a live certification. CAPTCHA and
managed-auth were not exercised because no challenge or account was authorized.
