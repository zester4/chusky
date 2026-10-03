Make this update as a branch in our github called /e2b-updates
The main problem is not that the browser lacks capability. It is that the current implementation has a weak boundary between “what the page looked like” and “what the next action is allowed to target.”

The Railway errors are consistent with that weakness.

## Overall verdict

We have built:

- a real E2B sandbox runtime;
- a headed persistent Chromium browser;
- Playwright automation;
- accessible page inspection;
- account-scoped sessions;
- vault-based credential injection;
- private human handoff;
- network restrictions;
- approvals and auditability;
- browser file handling;
- mission/task integration.

But the current interaction model is still too dependent on:

```text
role + accessible name + nth(index)
```

That is the central reliability problem.

The browser is powerful enough in raw capability, but not yet robust enough in state tracking, locator recovery, frame handling, startup diagnostics, or verified end-state completion.

## Comparison: Railway error vs current implementation

| Railway error | Current implementation | Assessment |
|---|---|---|
| `E2B browser daemon did not become ready: not-ready` | Starts Xvfb, Fluxbox, and the browser daemon, then polls `/health` | Correct basic design, insufficient diagnostics |
| `Legal first name` locator timeout | Reconstructs `getByRole(...).nth(1)` from a saved node | Fragile and likely stale |
| `Legal last name` locator timeout | Reconstructs `getByRole(...).nth(2)` | Fragile and likely stale |
| `Create a password` timeout | Reconstructs `getByRole(...).nth(3)` | Fragile and likely stale |
| `fresh accessible node selector` | Requires a recent saved node ID | Correct safety rule, but freshness only means age, not unchanged DOM state |
| No successful completion receipt | Returns the browser result to the model | Too weak; completion must be verified by the runtime |

## 1. E2B startup is under-diagnosed

Current startup logic:

- connects to an existing E2B sandbox or creates one;
- starts Xvfb;
- starts Fluxbox;
- starts `browser-agent.mjs`;
- polls `http://127.0.0.1:8765/health`;
- returns only `not-ready` when the health check fails.

That explains the Railway error:

```text
E2BBrowserError:
E2B browser daemon did not become ready: not-ready
```

The issue is not necessarily that E2B itself was unavailable. The failure could be anywhere inside the sandbox:

- Chromium crash;
- Playwright browser launch failure;
- missing browser binary;
- Xvfb failure;
- Fluxbox failure;
- browser-agent syntax/runtime failure;
- port binding failure;
- sandbox startup race;
- insufficient memory;
- stale retained sandbox;
- E2B command timeout.

The current code does not expose enough information to distinguish these.

Context7’s E2B documentation confirms that the SDK supports explicit creation timeouts, request timeouts, metadata, reconnecting by sandbox ID, and SDK logging. The current code uses timeouts and metadata, but does not configure a useful E2B logger or collect structured startup diagnostics.

### Fix

Create a structured startup probe that returns:

```ts
{
  sandboxId,
  template,
  phase: "connect" | "xvfb" | "fluxbox" | "browser-agent" | "health",
  processStatus: {
    xvfb: "running" | "missing" | "unknown",
    fluxbox: "running" | "missing" | "unknown",
    browserAgent: "running" | "missing" | "unknown",
    chromium: "running" | "missing" | "unknown"
  },
  healthStatus,
  healthBody,
  recentLogs: redactedLogs
}
```

The probe should safely inspect:

```text
/tmp/chusky-xvfb.log
/tmp/chusky-fluxbox.log
/tmp/chusky-browser.log
```

It should never return credentials, cookies, page content, or raw secret-bearing environment values.

Also:

- retry E2B connect with bounded exponential backoff;
- use E2B `isRunning()` or `getInfo()` before killing a retained sandbox;
- only retire the sandbox after confirmed unrecoverable failure;
- configure an E2B SDK logger or structured diagnostic callback;
- add a browser-agent `/health` response containing process and Chromium state;
- add `page.on("crash")`, `context.on("close")`, and browser-agent process failure reporting.

## 2. The current selector model is the main browser bug

The browser runtime generates node IDs using:

```text
role + name + index
```

The template then resolves them using:

```js
page.getByRole(role, options).nth(index)
```

That is exactly what the Railway logs show:

```text
getByRole('textbox', { name: 'Legal first name', exact: true }).nth(1)
```

The problem is that `nth(1)` is not an identity. It is only the current position of an element in a locator result set.

It can change because of:

- hidden fields;
- duplicated responsive controls;
- a rerender;
- a modal opening;
- a validation message;
- a new form step;
- an iframe;
- a changed accessibility tree;
- localization;
- a site redesign;
- lazy-loaded controls;
- an SPA route transition.

The current node freshness check only checks:

```text
capturedAt < two minutes old
```

It does not check:

- same page generation;
- same tab;
- same frame;
- same URL;
- same DOM/accessibility fingerprint;
- same form state;
- same locator count;
- same element identity.

Therefore a node can be “fresh” by time while being stale in reality.

### Fix: make observations state-bound

Every observation should create an `observationId` and include:

```ts
type BrowserObservation = {
  observationId: string;
  tabId: string;
  framePath: string[];
  url: string;
  title: string;
  pageGeneration: number;
  accessibilityHash: string;
  candidates: BrowserCandidate[];
}
```

An action must include the observation ID it was derived from.

Before execution, the browser daemon should verify:

1. the same tab is active;
2. the same origin is active;
3. the same frame exists;
4. the observation is not expired;
5. the page generation has not changed;
6. the candidate still resolves uniquely.

If any condition fails, return:

```text
observation_stale
```

and require a fresh snapshot.

## 3. Stop silently relying on `nth()`

Context7’s Playwright documentation recommends user-facing locators such as `getByRole`, which is correct. But it does not mean that `getByRole(...).nth(index)` is reliable as a durable selector.

The improved resolution strategy should be:

### First choice: unique accessible locator

```ts
page.getByRole("textbox", { name: "Legal first name", exact: true })
```

Use it only if it resolves to exactly one visible element.

### Second choice: stable attributes

During observation, capture safe structural metadata:

- `id`;
- `name`;
- `placeholder`;
- `autocomplete`;
- `type`;
- associated `<label>`;
- `aria-labelledby`;
- `aria-describedby`;
- nearby form name;
- frame path.

Do not expose arbitrary CSS or XPath to the model, but the trusted runtime can store a safe selector recipe.

Example internal recipe:

```ts
{
  role: "textbox",
  name: "Legal first name",
  autocomplete: "given-name",
  inputType: "text",
  framePath: [],
  formSignature: "..."
}
```

### Third choice: explicit disambiguation

If there are multiple matches, do not automatically choose `.nth()`.

Return:

```text
ambiguous_control
```

with bounded candidates:

```text
1. Legal first name — visible — registration form
2. Legal first name — hidden — mobile form
```

Then let the agent choose after inspecting the new observation.

### Last resort: coordinate interaction

Coordinates should remain restricted to exceptional custom controls and human handoff scenarios, not used to bypass locator ambiguity.

## 4. The current implementation does not properly support frames

The browser template’s `roleMatches()` and `locatorFor()` operate against the main `page`:

```js
page.getByRole(...)
```

They do not appear to inspect or resolve controls inside nested frames.

That can produce exactly the same symptom as a missing field: the field exists visually, but Playwright searches the wrong document.

This matters for:

- payment forms;
- identity providers;
- embedded signup forms;
- consent widgets;
- checkout controls;
- third-party authentication pages.

### Fix

Observation should include frame-aware candidates:

```ts
{
  nodeId,
  role,
  name,
  framePath: [
    { url: "https://provider.example/frame", index: 0 }
  ]
}
```

Resolution should use:

```ts
const frame = page
  .frames()
  .find(/* trusted frame identity */);

frame.getByRole(...)
```

The frame must be revalidated before action execution.

Context7’s Playwright documentation specifically emphasizes narrowing frame locators and treating frame selection as part of locator correctness.

## 5. The current agent recovery is too repetitive

The Railway sequence was:

```text
first name timeout
last name timeout
last name timeout again
run settles

first name timeout
last name timeout
password timeout
first name timeout
fresh-selector rejection
run settles
```

This shows the agent continued trying variations of the same plan instead of entering a recovery state.

### Fix

Add a browser-specific recovery state machine:

```text
action_failed
  ↓
reinspect_current_page
  ↓
compare observation/page generation
  ↓
retry once with fresh candidate
  ↓
if still failing:
  ├─ frame discovery
  ├─ page-transition diagnosis
  ├─ human handoff
  └─ blocked with explanation
```

Rules:

- one retry for a transient wait;
- one reinspection after a locator failure;
- no repeated replay of the same locator;
- no automatic change from a read-only action to a risky action;
- no completion claim without postcondition evidence.

A useful error classification would be:

```ts
type BrowserFailure =
  | "sandbox_startup"
  | "page_navigation"
  | "page_load"
  | "control_missing"
  | "control_ambiguous"
  | "stale_observation"
  | "frame_missing"
  | "challenge_detected"
  | "policy_blocked"
  | "verification_failed"
  | "provider_error";
```

## 6. The current browser lacks runtime-level postconditions

Playwright actions auto-wait for actionability. Context7 recommends combining actions with assertions such as:

```ts
await expect(locator).toBeVisible();
await expect(locator).toHaveValue(...);
await expect(page.getByText("Success")).toBeVisible();
```

The current implementation performs the action and returns the browser result, but it does not require a postcondition at the runtime level.

That leaves too much responsibility to the model.

### Fix

Introduce a trusted `verify` operation:

```ts
CHUCK_BROWSER_VERIFY_STATE
```

Supported checks:

- URL/origin changed;
- title changed;
- text appeared;
- control became visible;
- control disappeared;
- field value changed;
- download became ready;
- success detector matched;
- failure detector matched;
- authentication state changed.

For consequential operations, the tool should not return `completed: true` until verification passes.

Example:

```ts
{
  action: "click",
  observationId: "...",
  nodeId: "...",
  expected: {
    any: [
      { textIncludes: "Account created" },
      { urlIncludes: "/welcome" },
      { role: "heading", name: "Welcome" }
    ]
  }
}
```

If no expected result is supplied, the runtime should return:

```text
action_executed_verification_required
```

rather than success.

## 7. The current `wait` model should improve

The browser currently uses generic delays and `waitForLoadState("domcontentloaded")`.

That is insufficient for modern SPAs because:

- DOMContentLoaded may already have happened;
- the page can still be rendering;
- API calls may still be in flight;
- forms may appear after hydration;
- route changes may not reload the document.

### Fix

Replace generic waits with bounded semantic waits:

- wait for a specific accessible control;
- wait for URL change;
- wait for a specific text marker;
- wait for network idle only when safe;
- wait for a known loading indicator to disappear;
- wait for a trusted page-generation change.

Do not use arbitrary sleep as the main synchronization strategy.

## 8. Browser startup and browser interaction need separate health states

Currently, a browser can be recorded as available even though the daemon, page, Chromium process, or retained profile is unhealthy.

Track separate health:

```text
sandbox:
  running | stopped | expired | unreachable

daemon:
  starting | ready | unhealthy | crashed

chromium:
  starting | ready | crashed | closed

page:
  unknown | loading | ready | challenge | blocked

vault:
  logged_out | authenticating | authenticated | needs_user

observation:
  fresh | stale | invalid
```

`CHUCK_BROWSER_STATUS` should return all of these safely.

## 9. The current code has good security boundaries

These should be preserved:

- private/local network blocking;
- URL credential rejection;
- owner-scoped sandbox records;
- private browser files;
- vault credential isolation;
- authenticated-session coordinate restrictions;
- approval gates;
- same-origin handoff verification;
- bounded page content;
- redaction;
- no secrets in model arguments.

Do not weaken these in the pursuit of better automation.

The correct goal is:

```text
more reliable observation and recovery
```

not:

```text
allow arbitrary clicks when observation is uncertain
```

## Recommended implementation order

### Phase 1: fix the production incident

1. Add E2B startup diagnostics.
2. Add browser-agent health details.
3. Capture Chromium/Xvfb/Fluxbox process state.
4. Add bounded retries around sandbox connect and daemon startup.
5. Run the live E2B smoke test against the exact Railway template.

### Phase 2: fix selector reliability

1. Add observation IDs.
2. Add page-generation and accessibility-tree hashes.
3. Add tab and frame identity.
4. Stop automatically choosing `.nth()`.
5. Require unique locator resolution.
6. Return `ambiguous_control` instead of guessing.

### Phase 3: add frame and SPA support

1. Enumerate trusted frames.
2. Store frame paths in observations.
3. Resolve locators inside the correct frame.
4. Add route-change and DOM-generation tracking.
5. Replace generic waits with semantic waits.

### Phase 4: add recovery and verification

1. Add browser failure classifications.
2. Add one automatic reinspection retry.
3. Add challenge detection.
4. Add trusted postcondition verification.
5. Require evidence before completion.
6. Pause instead of repeating when the page remains ambiguous.

### Phase 5: strengthen durable browser work

1. Persist browser observation checkpoints inside missions.
2. Store the last verified page state, not raw page content.
3. Resume by inspecting live state first.
4. Reconcile uncertain writes before retrying.
5. Never repeat checkout, purchase, submission, or account mutation without checking whether it already succeeded.

## Target end-to-end flow

The robust flow should become:

```text
1. Start or reconnect E2B sandbox
2. Verify sandbox and browser daemon health
3. Open or resume the intended origin
4. Capture observation:
   - URL
   - title
   - tab
   - frame
   - page generation
   - accessible candidates
   - challenge state
5. Create a browser plan
6. Select one candidate
7. Revalidate observation and candidate
8. Execute one action
9. Capture the new observation
10. Verify the expected postcondition
11. Record evidence
12. Continue, pause, hand off, or complete
```

For high-impact actions:

```text
inspect
→ propose
→ approval
→ execute
→ provider/page readback
→ verify
→ durable receipt
```

## What “done” should mean

The browser system should be considered production-ready when:

- E2B startup failures identify the actual failing phase;
- browser-agent crashes are observable;
- locators do not depend solely on ordinal indexes;
- stale observations are detected by state, not just time;
- frames are supported;
- locator failures trigger reinspection rather than repetition;
- every consequential action has a postcondition;
- uncertain writes reconcile before retry;
- missions can resume from a verified browser checkpoint;
- successful completion always includes evidence;
- live E2B smoke tests pass against the production template;
- Railway logs clearly distinguish infrastructure, Playwright, policy, challenge, and verification failures.

The current system is a strong foundation, but the next major improvement is not adding more browser actions. It is making the existing actions state-aware, frame-aware, recoverable, and verification-driven.