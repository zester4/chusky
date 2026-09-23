# Daytona audit: browser, computer, PDFs, and execution

The main conclusion is that Chusky already has a strong Computer Use foundation. You are not missing the basic Daytona mouse, keyboard, screenshot, recording, or accessibility primitives.

The larger gaps are higher-level capabilities: persistent process sessions, code-interpreter contexts, LSP/code intelligence, sandbox forking, volumes, streaming file transfers, metrics, lifecycle controls, and stronger browser verification.

I audited the current repository against the installed Daytona SDK and first-party Daytona documentation. The relevant implementation is mainly:

- [agentTools.ts](C:/Users/mseyy/Downloads/tg-agent/src/agentTools.ts)
- [engine.ts](C:/Users/mseyy/Downloads/tg-agent/src/lib/daytona/engine.ts)
- [nativeTools.ts](C:/Users/mseyy/Downloads/tg-agent/src/nativeTools.ts)
- [policy.ts](C:/Users/mseyy/Downloads/tg-agent/src/policy.ts)
- [daytona types](C:/Users/mseyy/Downloads/tg-agent/src/lib/daytona/types.ts)

I could not directly invoke the Exa or Context7 connectors in this environment, so I used the local SDK declarations and official Daytona documentation.

## Current capability assessment

| Area | Current Chusky state | Assessment |
|---|---|---|
| Computer Use | Mouse, keyboard, screenshots, screen regions, recordings, display info, windows, process diagnostics, accessibility tree and actions | Strong |
| Browser wrapper | Open, back, forward, refresh, click, type, press, scroll, accessibility find/focus/invoke/fill | Useful but fragile |
| Daytona sandbox | Create, recover, start, pause, archive, delete, execute commands, network policy, snapshots | Good foundation |
| Files | Read/write/list/search/move/delete/details | Functional, but not optimized for large workspaces |
| PTY | Create/read/write/status/resize/kill | Functional, but not true durable streaming sessions |
| PDFs | ReportLab generation, fallback renderer, structural validation, LibreOffice/Poppler rendering | Strong baseline |
| DOCX/PPTX/XLSX | Native generation plus conversion/render validation | Good, but QA is mostly structural |
| Security | Vault broker, private browser boundaries, account labels, approval policy, redaction | Strong and important |
| SDK freshness | Pinned to `@daytona/sdk` `0.207.0`; current official changelog shows `0.215.0` | Upgrade needed |

Daytona’s official Computer Use API includes the same basic primitives currently exposed by Chusky: mouse, keyboard, screenshots, recordings, display operations, process diagnostics, and accessibility operations. Chusky is therefore close to parity at the low-level Computer Use layer. [Daytona Computer Use documentation](https://www.daytona.io/docs/en/computer-use/)

## What Chusky already does well

### Computer execution

Chusky exposes nearly all of Daytona’s current Computer Use primitives:

- Start, stop, status, and process diagnostics
- Full compressed screenshots and region screenshots
- Mouse movement, clicks, scrolling, dragging, and cursor position
- Keyboard typing, key presses, and hotkeys
- Window and display inspection
- Screen recording lifecycle
- Accessibility tree inspection
- Accessibility node finding, focus, invoke, and value setting

That is substantially better than a simple browser automation wrapper. It can operate the entire Daytona desktop, not only a browser page.

The vault boundary is also a significant strength. Credentials are not handed to the model as plaintext. Login actions are brokered through the vault, and browser values are redacted before being returned. That design should be preserved.

### Browser interaction

`CHUCK_DAYTONA_BROWSER` is a useful convenience layer over Computer Use. It simplifies common browser tasks while keeping the lower-level computer tool available for unusual interfaces.

The agent prompt also correctly requires:

- Inspecting the screen or accessibility tree before acting
- Using vault authentication for credentials
- Verifying important actions afterward
- Avoiding claims of completion without tool evidence

That is the right behavioral foundation.

### Artifact and PDF pipeline

The artifact subsystem is one of the strongest parts of the current system:

- PDF generation through ReportLab
- DOCX generation through `docx`
- XLSX generation through ExcelJS
- PPTX generation through PptxGenJS
- Structural validation
- LibreOffice conversion for Office formats
- Poppler rendering
- Page-count limits
- File-size limits
- Fail-closed behavior when a renderer is unavailable
- Artifact registration and delivery by artifact ID

This is significantly beyond “generate a file and hope it opens.”

## The most important missing Daytona features

### 1. Stateful process sessions

Current Chusky mainly uses command execution and PTYs. Daytona also supports durable process sessions with:

- Session creation
- Session metadata
- Stateful commands
- Session command logs
- Streaming output
- Input injection
- Session listing and deletion
- Entrypoint sessions

The current PTY implementation reconnects and collects bounded output, but it is not a full durable process/session abstraction.

This matters for:

- Long-running development servers
- Test suites
- Interactive Python or Node sessions
- Browser debugging processes
- Background workers
- Streaming build output
- Resumable jobs after Telegram or dashboard disconnects

Daytona explicitly documents stateful process sessions and streaming logs. [Daytona Process SDK](https://www.daytona.io/docs/en/typescript-sdk/process/)

Recommended addition:

```text
CHUCK_DAYTONA_SESSION
  create
  list
  get
  execute
  input
  logs
  status
  stop
  delete
```

The implementation should support:

- Account and mission ownership
- Bounded output buffers
- Streaming to channels
- Backpressure
- Cancellation
- Reconnection
- Idempotency keys
- Automatic cleanup and TTL

This is probably the highest-value execution upgrade.

### 2. Code Interpreter contexts

The SDK includes a Code Interpreter capability that supports persistent Python contexts, execution callbacks, and context lifecycle management. Chusky currently makes agents use shell commands for this type of work.

That is weaker for:

- Data analysis
- PDF and document inspection
- Spreadsheet generation
- Charts
- Image analysis
- CSV/JSON transformations
- Multi-step scientific or financial calculations

Add an internal or user-facing:

```text
CHUCK_DAYTONA_CODE
  create_context
  list_contexts
  run
  interrupt
  delete_context
```

Keep it separate from general shell execution. A Python context should have:

- A bounded filesystem scope
- Explicit network policy
- Output truncation
- Image/artifact capture
- Execution timeout
- Context ownership
- Cancellation

Daytona documents persistent interpreter contexts separately from generic process execution. [Daytona Code Interpreter](https://www.daytona.io/docs/en/typescript-sdk/code-interpreter/)

### 3. Sandbox forking

Chusky has snapshot creation, but does not appear to expose Daytona’s stable sandbox fork capability.

A fork duplicates a sandbox’s working state much faster than rebuilding from scratch. This is very important for sub-agents and risky actions.

Use forks for:

- Parallel sub-agent missions
- Browser experimentation
- Safe code repair attempts
- Document-generation retries
- Regression reproduction
- User “try another approach” requests
- Approval-gated changes

Current Chusky uses a deterministic `chusky-${userId}` workspace. That creates a concurrency risk: multiple missions or sub-agents can collide inside one sandbox.

A better model is:

```text
account sandbox
  ├── mission fork
  ├── sub-agent fork
  ├── browser task fork
  └── artifact-renderer fork
```

The parent workspace remains stable while each mission receives an isolated child.

Daytona documents sandbox forking and snapshot persistence. [Daytona Persistence](https://www.daytona.io/docs/en/persistence/) and [stable sandbox fork release](https://www.daytona.io/changelog/stable-sandbox-fork-and-snapshot-creation)

### 4. Volumes

Chusky currently ties most workspace state to the sandbox. Daytona provides persistent volumes that survive sandbox lifecycle changes and can be mounted into sandboxes.

Volumes would improve:

- Large project repositories
- Artifact storage
- Browser downloads
- Model-generated datasets
- Long-lived user workspaces
- Cross-fork shared assets
- Recovery after sandbox deletion

Do not place sensitive credentials in ordinary volumes. Keep secrets in the vault or Daytona’s secret service.

[Daytona Volume documentation](https://www.daytona.io/docs/en/typescript-sdk/volume/)

### 5. Metrics and lifecycle management

The Daytona SDK supports metrics and additional lifecycle controls that are not meaningfully exposed by Chusky:

- CPU and memory metrics
- Disk usage
- Auto-pause
- Auto-stop
- TTL
- Auto-archive
- Auto-delete
- Resize
- Wait-until-started
- Wait-until-stopped
- Resource resize completion

This should feed both the agent and the dashboard.

For example, before starting a large PDF conversion or browser recording, the agent should know:

- Is the sandbox alive?
- Is it already CPU constrained?
- Is disk almost full?
- Is another mission using the browser?
- Is the sandbox scheduled for auto-pause?
- Would a fork be safer?

Current metadata exposes some sandbox information, but not enough operational telemetry.

### 6. LSP and code intelligence

Daytona includes an LSP server capability supporting operations such as:

- Completions
- Document open/close
- Document symbols
- Workspace symbol search
- Language-server diagnostics

Chusky currently relies heavily on file search and shell commands. That makes code understanding slower and less precise.

LSP would allow the agent to answer questions such as:

- Where is this function defined?
- Which callers depend on this interface?
- What symbols are exported from this module?
- What type errors exist before running the whole build?
- What files are affected by this change?

[Daytona LSP documentation](https://www.daytona.io/docs/en/typescript-sdk/lsp-server/) and [Daytona LSP guide](https://www.daytona.io/docs/en/language-server-protocol/)

This would be especially valuable for sub-agents doing repository work.

## Browser-specific gaps

### Full-resolution screenshots

Chusky exposes compressed screenshots, but the Daytona SDK also provides full-screen and full-region screenshot methods.

Compressed images are fine for routine navigation. They are weaker for:

- Small text
- PDF inspection
- Dense tables
- CAPTCHA-like controls
- Pixel-level UI verification
- Spreadsheet formatting
- Visual regression testing

Add optional:

```text
screenshot_full
screenshot_region_full
```

with explicit size, quality, and privacy limits.

Use compressed screenshots by default and full-resolution screenshots only when the agent requests them for a reason.

### Accessibility scope and filtering

The current browser accessibility search effectively searches broadly. Daytona supports more precise targeting by:

- Focused scope
- Process ID
- Role
- Name
- State
- Limit

Chusky should expose these filters. Broad searches increase the risk of finding the wrong button or field when multiple similar elements exist.

Recommended browser find arguments:

```json
{
  "role": "button",
  "name": "Submit",
  "scope": "focused",
  "states": ["enabled", "visible"],
  "limit": 5
}
```

### Browser-level drag and pointer control

The low-level computer tool supports pointer movement and dragging, but the browser convenience tool does not expose them directly.

That means the model must switch tools for common browser tasks such as:

- Drag-and-drop uploads
- Slider controls
- Calendar selection
- Kanban movement
- Resizing panels
- Selecting text or regions
- Drawing or canvas interfaces

Add browser-level:

```text
move
drag
mouse_position
```

These can still delegate to the Computer Use engine internally.

### Navigation verification

The current browser `open` action navigates by focusing the address bar, typing, and pressing Enter. It records the requested URL, but the action should verify the actual resulting state.

It should detect:

- Redirects
- Login pages
- Browser error pages
- Certificate warnings
- Download responses
- Blank pages
- Blocked domains
- Unexpected domain changes

The stronger flow is:

```text
navigate
  → wait for stability
  → inspect screenshot/accessibility tree
  → inspect current URL/title
  → verify expected domain/page
  → return evidence
```

The same principle should apply after every important click, submit, upload, and download.

### Browser sessions and leases

A persistent browser per user can become a collision point when multiple agents run concurrently.

Add browser session ownership:

```text
account
  ├── browser session: personal
  ├── browser session: mission-123
  └── browser session: sub-agent-456
```

Each session should have:

- Owner
- Mission ID
- Last activity
- Current domain
- Lock/lease
- Cancellation
- Cleanup policy
- Optional fork origin

This would prevent one sub-agent from navigating the browser while another is still using it.

### Downloads and browser state

The browser layer should eventually expose safe abstractions for:

- Download discovery
- Download completion
- Downloaded artifact registration
- Browser window/tab identity
- Current URL and title
- Page load state
- Browser errors

Do not expose cookies, session tokens, or unrestricted browser storage to the model. Those should remain inside the trusted browser/vault boundary.

## PDF and document creation gaps

The artifact system is good, but its visual QA is currently closer to rendering smoke testing than true document QA.

A non-empty PNG proves only that something rendered. It does not prove:

- Text was not clipped
- Tables fit on the page
- Fonts were embedded
- Headers and footers are correct
- Charts are readable
- Images are not missing
- Slide elements do not overlap
- A page is not accidentally blank
- Formulas recalculated
- Hyperlinks work
- Accessibility metadata exists

### Recommended artifact review pipeline

```text
generate
  → structural validation
  → convert/render
  → extract text and metadata
  → page-level visual inspection
  → type-specific validation
  → model review for high-value artifacts
  → register
  → deliver
```

For PDFs, add:

- Page count validation
- Text extraction
- Metadata validation
- Font inspection
- Link validation
- PDF/A option
- Blank-page detection
- Minimum text/content checks
- Optional accessibility checks

For DOCX:

- Relationship validation
- Image relationship validation
- Table integrity
- Header/footer checks
- Section and page-break checks

For PPTX:

- Slide count
- Slide relationship validation
- Overflow/overlap detection
- Speaker notes preservation
- Missing-font checks

For XLSX:

- Formula validation
- Recalculation handling
- Chart integrity
- Hidden-sheet checks
- External-link detection
- Cell-size and truncation checks

### Renderer network concern

The fallback PDF renderer currently creates a renderer sandbox with network enabled. That may be convenient for installing packages or retrieving resources, but it weakens the security boundary.

The preferred design is:

1. Build a preconfigured renderer snapshot.
2. Keep runtime network blocked.
3. Allow only explicitly approved resource domains when needed.
4. Cache fonts and packages in the snapshot.
5. Use warm pools for faster startup.

That would improve both security and latency.

### Artifact streaming

`downloadArtifact` currently loads the complete file into memory. Daytona provides streaming and pre-signed upload/download URLs.

Use streaming for:

- Large PDFs
- Video recordings
- ZIP packages
- Browser downloads
- Dataset artifacts
- Generated presentations

This will reduce memory spikes and improve delivery latency.

[Daytona File System documentation](https://www.daytona.io/docs/en/typescript-sdk/file-system/)

## SDK version and platform drift

The repository is pinned to `@daytona/sdk` `0.207.0`. The official Daytona changelog currently lists `0.215.0`.

Important Daytona capabilities added around the versions after your current pin include:

- More robust streamed uploads
- Stale-connection retry behavior
- Stable sandbox fork and snapshot operations
- Pre-signed file URLs
- Metrics
- Auto-pause
- Secrets and environment updates
- MCP Computer Use tools
- Domain allow lists
- Warm pool management

[Daytona changelog](https://www.daytona.io/changelog)

I would not blindly upgrade in production. I would create a compatibility branch and run:

```text
npm install @daytona/sdk@latest
npm run typecheck
npm test
npm run build
```

Then specifically test:

- Workspace creation and recovery
- Network policy reconciliation
- Computer Use startup
- Accessibility operations
- Browser handoff
- File upload/download
- Snapshot creation
- PDF fallback renderer
- Artifact registration
- PTY reconnect behavior

## Recommended implementation order

### P0: correctness and observability

1. Upgrade Daytona SDK with compatibility tests.
2. Add Daytona capability detection at startup.
3. Add metrics, disk checks, and sandbox health state.
4. Verify navigation after every browser navigation action.
5. Add focused accessibility search with role/state/scope filters.
6. Add full-resolution screenshots.
7. Add explicit browser session leases.
8. Gate destructive artifact deletion with approval when physical files are removed.
9. Replace whole-file artifact downloads with streaming.

### P1: agent power

1. Durable Daytona process sessions.
2. Code Interpreter contexts.
3. Sandbox forks for missions and sub-agents.
4. LSP tools.
5. Volumes for durable workspace/artifact data.
6. Lifecycle controls: TTL, auto-pause, stop, resize, recovery.
7. Streaming logs with cancellation and backpressure.

### P2: browser capability

1. Browser-level move/drag/pointer operations.
2. Window/tab identity and targeting.
3. Download completion and artifact registration.
4. Current URL/title/page-state inspection.
5. Better stale accessibility-node handling.
6. Browser task recording and replay metadata.
7. Optional browser-native inspection layer if supported safely by the runtime.

### P3: artifact quality

1. Semantic PDF validation.
2. Type-specific DOCX/PPTX/XLSX validation.
3. Contact sheets or page previews for model review.
4. Mandatory visual review for high-value deliverables.
5. Renderer snapshot and warm pool.
6. Renderer network lockdown.
7. Artifact versions and diff/rollback.

## Architectural recommendation

Do not expose every Daytona SDK method as an individual raw tool. That would make the model slower and increase tool-selection errors.

Instead, create a small number of higher-level Chusky capabilities:

```text
CHUCK_DAYTONA_SANDBOX
  health
  metrics
  fork
  snapshot
  lifecycle
  resize

CHUCK_DAYTONA_SESSION
  create
  execute
  stream
  input
  cancel
  close

CHUCK_DAYTONA_CODE
  context
  run
  inspect
  artifact

CHUCK_DAYTONA_BROWSER
  navigate
  inspect
  locate
  act
  verify
  download

CHUCK_DAYTONA_FILES
  stream
  bulk_transfer
  replace
  permissions

CHUCK_DAYTONA_LSP
  diagnostics
  symbols
  completion
  workspace_search
```

Internally, these can map to the complete Daytona SDK while preserving Chusky’s account isolation, approvals, vault rules, and channel-neutral contracts.

## Bottom line

Chusky is already strong at low-level Computer Use and document generation. The competitive advantage will come from making those primitives durable, concurrent, observable, and self-verifying.

The three highest-impact upgrades are:

1. Durable Daytona process sessions with streaming.
2. Sandbox forks plus volumes for isolated sub-agent execution.
3. A browser verification layer with full screenshots, scoped accessibility, session leases, and navigation evidence.

After that, add Code Interpreter, LSP, metrics, renderer hardening, and semantic artifact QA. Those changes would make Chusky substantially more capable than a collection of browser tools because it would operate as a reliable execution system rather than merely controlling a desktop.

## Implementation status after the 2026-09-23 re-audit

The repository now implements the highest-impact items above against `@daytona/sdk` 0.215.0:

- account-owned Daytona volumes with creation-time mounts and safe `/home/user/...` mount validation;
- sandbox health and lifecycle waits, with diagnostic reads avoiding an unnecessary start of paused sandboxes;
- native Daytona process-log streaming and streamed artifact downloads for the API and CLI paths;
- browser session leases with owner scoping, TTLs, mission identifiers, collision prevention, and cancellation cleanup;
- bounded download discovery and explicit artifact registration;
- capability reporting for Computer Use, process sessions, Code Interpreter, LSP, streaming files, and volumes;
- artifact renderer network lockdown preserved during validation, plus structural PDF/Office QA and bounded rendering checks;
- focused Daytona/API regression coverage and repository-wide verification.

The remaining items are now narrower platform/conformance gaps, not silently assumed to be complete:

1. Daytona's current Computer Use surface is still desktop-window oriented rather than a first-class browser-tab API. Chusky now reads a sanitized address-bar URL, focused window title, accessibility state, and a bounded settled/unknown load signal when the desktop exposes them; it still does not invent browser protocol data when the provider does not expose it.
2. Download discovery remains bounded to conventional workspace download directories, but wait_download now waits for a stable non-zero file before registration. A provider-specific browser download event would remove the last directory-scan dependency.
3. HTTP/CLI artifact delivery streams bytes, and Telegram uploads directly from a Daytona stream. Email and client SDK responses still materialize bytes where their connected-provider or public response contracts require complete payloads.
4. Artifact QA now includes qpdf syntax checks, encrypted-PDF rejection, Poppler font inspection, full-page rendering, and Office conversion checks. Full PDF/A certification and accessibility-tag conformance still require a dedicated conformance validator and an explicit product policy for image-only and untagged PDFs.

Verification on this revision: `npm run typecheck`, `npm run build`, focused Daytona/API tests (99/99), and `npm test` (673 passed, 4 skipped, 0 failed). The SDK upgrade also reports 11 npm audit advisories (8 moderate, 2 high, 1 critical), which should be triaged separately rather than auto-fixed blindly.
