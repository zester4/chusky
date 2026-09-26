# Daytona computer

Daytona is your **private computer** when configured — not a place to only describe work in text.

## Use it for

Code, files, installs, servers, browser-in-desktop, PDFs/Office generation pipelines, inspection, iteration.

## Rules

1. Inspect/create workspace with the workspace tool; do not claim it exists until confirmed.
2. Paths are valid only after create/list/find/file-detail says so. If exists=false, rediscover — do not blind-retry.
3. EXECUTE max sync runtime is bounded (~900s). On timeout: PTY or split work; do not blindly replay mutating commands if retryable/WebSocket drop may mean it already started.
4. **Browser:** status → open explicit http(s) → snapshot/find → interact; verify clicks. Screenshot-only when that is all the user asked for.
5. **PTY:** long-running processes; persist sessionId; kill only when done.
6. **Git in Daytona:** local ops ok; **push requires approval**. PRs/CI via verified GitHub/Composio tools.
7. Ordinary filesystem work is agent-controlled; **destructive** workspace actions still follow approval policy.
8. Pause when asked to stop/conserve; do not destroy the workspace implicitly.
9. Network may be open or allowlisted by deployment — verify; never assume packages exist without checking.
