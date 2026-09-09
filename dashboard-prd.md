# Chusky Dashboard Interface — Product Requirements Document

## 1. Product summary

Chusky is a multi-channel AI operations platform. The dashboard gives users one place to see conversations, agents, connected applications, tasks, artifacts, Daytona workspaces, approvals, memory, usage, and billing.

The dashboard must make the system feel understandable and trustworthy: users should always know what an agent is doing, which tools it used, what it changed, what requires approval, and where the resulting work can be found.

## 2. Goals

- Give users a clear operational overview immediately after sign-in.
- Make every agent run inspectable from request through final result.
- Let users configure specialist agents, connected accounts, permissions, memory, schedules, and approval rules.
- Make generated files and running apps easy to preview, download, share, and continue editing.
- Support private conversations, Telegram groups, iMessage/Sendblue groups, WhatsApp groups, and other connected channels without mixing private data.
- Surface failures with actionable recovery steps rather than raw stack traces.
- Work well on desktop, tablet, and mobile.

## 3. Non-goals for the first release

- Replacing the existing Telegram or iMessage clients.
- Building a full CRM, project-management suite, or accounting system.
- Exposing arbitrary infrastructure controls without a permission boundary.
- Adding Browserbase, Firecrawl, or other browser backends to the product UI before their backend integrations are approved.

## 4. Primary users

### Individual operator

Needs quick visibility into tasks, reminders, conversations, files, and connected accounts.

### Small-business owner

Needs agents to handle research, customer communication, documents, follow-ups, and recurring work with minimal supervision.

### Team administrator

Needs shared workspaces, role-based access, audit logs, approvals, usage controls, and billing visibility.

### Technical builder

Needs Daytona workspaces, app previews, logs, file inspection, test results, GitHub delivery, and reproducible agent runs.

## 5. Global application shell

### Header

- Workspace switcher.
- Global search across conversations, tasks, agents, files, memories, and integrations.
- Create button: new task, new agent run, new schedule, new artifact, connect app.
- Notifications and approval count.
- Help/documentation link.
- User avatar, account menu, theme selector, and sign out.

### Left navigation

- Overview
- Inbox / Conversations
- Agents
- Tasks & Runs
- Automations
- Artifacts
- Workspaces
- Integrations
- Memory
- Analytics
- Approvals
- Settings

Navigation items show unread, failed, or pending counts where useful. The sidebar collapses to icons on tablet and becomes a bottom/navigation drawer on mobile.

### Global UI conventions

- Every long-running action has a visible status, elapsed time, cancel action, and retry/resume action where supported.
- Every result shows its source channel, owner, agent, timestamp, and related task.
- Destructive actions require confirmation and identify the exact scope.
- Toasts are supplementary; important state is also visible in the page.
- URLs, artifact IDs, run IDs, and approval IDs can be copied.

## 6. Page requirements

### 6.1 Overview

Purpose: answer “What is happening now?” within five seconds.

Features:

- KPI cards: active runs, pending approvals, scheduled jobs, connected accounts, artifacts created, estimated usage.
- Live activity feed with agent name, truncated instruction, status, channel, and timestamp.
- “Needs attention” panel for failed runs, expired approvals, disconnected accounts, and workspace errors.
- Upcoming automation timeline.
- Recent artifacts with file type, preview thumbnail, owner, and download/share actions.
- Quick actions for asking Chusky, delegating to a specialist, connecting an app, and creating an artifact.
- Date range and workspace filters.

States: first-run empty state, healthy state, degraded state, offline state, loading skeleton, and permission-limited state.

### 6.2 Inbox / Conversations

Purpose: inspect and continue conversations across channels.

Features:

- Conversation list grouped by channel: Telegram, iMessage, WhatsApp, Slack, and private chat.
- Search, unread filter, channel filter, group/private filter, and date filter.
- Conversation detail with messages, attachments, tool progress, delegation cards, approval cards, and artifact delivery cards.
- Channel identity and group membership panel.
- Clear-history action with explicit scope and confirmation.
- Conversation-level model selection, group access, and notification settings.
- “Open in channel” link where supported.
- Artifact and generated-media drawer for the current conversation.

Message features:

- Render text, markdown, tables, images, videos, files, links, code, and citations.
- Show which specialist received a delegated task and a truncated instruction preview.
- Expandable tool call details with input, output summary, duration, and status.
- Retry failed tool calls only when safe.

### 6.3 Agents

Purpose: configure and understand Chusky and specialist workers.

Agent directory:

- Chusky supervisor.
- Nora research.
- Lucas engineering.
- Leo creative/media.
- Maya growth/social/integrations.
- Sofia voice/calls.
- Dexter computer use.
- Elena schedules and durable tasks.

Agent cards show domain, current status, active tasks, recent success rate, available tools, and last activity.

Agent detail:

- Identity, mission, operating instructions, and capability summary.
- Allowed native tools and scoped Composio tools.
- Connected accounts available to the agent.
- Memory categories the agent can read/write.
- Current and historical tasks.
- Tool-call budget, time budget, and concurrency limits.
- Pause, resume, cancel, and reset controls.
- Test-run panel with a safe sample request.

### 6.4 Tasks & Runs

Purpose: track work from request to completion.

Features:

- Table and kanban views.
- Filters for agent, status, channel, owner, date, priority, and workspace.
- Run states: queued, running, waiting for approval, waiting for event, paused, completed, failed, cancelled, expired.
- Run detail timeline: received request, plan, delegation, tool calls, checkpoints, artifacts, preview URLs, approvals, and final response.
- Resume from durable checkpoint.
- Retry only failed stage or retry entire task.
- Cancel with reason.
- Cost, token, tool-call, and duration summary.
- Export run history as JSON or CSV for administrators.

### 6.5 Automations

Purpose: create and manage recurring work.

Features:

- Automation list with owner agent, schedule, channel destination, next run, last run, and status.
- Create/edit flow: objective, responsible specialist, schedule/time zone, destination channel, inputs, allowed tools, approval policy, retry policy, and expiration.
- Preview next five run times.
- Pause, resume, run now, duplicate, and delete.
- Run history and per-run output.
- Explicit distinction between “remind the user” and “invoke the specialist to perform work.”

### 6.6 Artifacts

Purpose: manage files created or registered by agents.

Supported types:

- PDF, DOCX, PPTX, XLSX, images, video, ZIP, reports, and app/project bundles.

Features:

- File grid and table views.
- Preview, download, rename, tag, share, duplicate, archive, and delete.
- Version history with source run and agent.
- Preview metadata: pages/slides/sheets, size, created date, validation status, visual QA status.
- Delivery history showing which channel/group received the artifact.
- Reopen/edit in Daytona when a workspace source exists.
- Failed-validation panel with exact repair guidance.

Artifact detail must show whether the file was structurally validated, visually rendered, and actually delivered.

### 6.7 Workspaces

Purpose: provide controlled Daytona computer and development environments.

Features:

- Workspace list with status, region, resources, network policy, lifecycle, owner, and last activity.
- Workspace detail tabs: Overview, Files, Terminal, Browser, Preview, Logs, Processes, Environment, Activity.
- File browser with text preview and safe edit controls.
- Terminal with command history, cancellation, and output streaming.
- Browser tab with screenshots, accessibility snapshot, DOM inspection, navigation history, and session state.
- App preview with public/private URL, health status, port, logs, and stop/restart controls.
- Build/test panel with command, result, duration, and captured output.
- Workspace cleanup controls with confirmation and retention information.

Network state must be obvious: enabled, blocked, temporary failure, or unknown.

### 6.8 Integrations

Purpose: connect and manage accounts used by Chusky and specialists.

Features:

- Integration catalogue grouped by communication, productivity, storage, development, research, and finance.
- Connected-account list supporting multiple accounts per app.
- Account label, owner, scopes, last verification, health, and assigned agents.
- Connect, reconnect, test, rename, disable, and revoke.
- Per-agent and per-workspace access assignment.
- Search tools by intent and inspect tool schemas from the main supervisor only.
- Connection error guidance with OAuth retry and missing-scope explanation.

### 6.9 Memory

Purpose: make durable context visible and controllable.

Features:

- Memory search and filters by category, source, confidence, owner, and last updated.
- Categories: profile, preference, brand, decision, project, contact, workflow, and channel.
- Memory detail with value, evidence/source, created date, expiry, and agents allowed to read it.
- Create, edit, approve, forget, and restore.
- Shared operating profile for voice, brand, priorities, and exceptions.
- Separate private memory from shared group/project memory.
- Clear explanation when a specialist cannot access a memory.

### 6.10 Analytics

Purpose: prove operational value and control spend.

Features:

- Runs completed, success rate, average duration, failure rate, approval wait time, and human takeover rate.
- Work by agent, channel, integration, task type, and workspace.
- Artifact counts and delivery success.
- Usage/cost by model, tool family, and workspace.
- Time saved estimate with configurable assumptions.
- Export and scheduled reports.
- Alerts for unusual tool volume, repeated failures, or cost spikes.

### 6.11 Approvals

Purpose: centralize actions requiring user confirmation.

Features:

- Pending, approved, rejected, expired, and consumed tabs.
- Exact action, arguments summary, destination, responsible agent, risk explanation, and expiration.
- Approve once, approve for this task, or reject with reason.
- Never hide the external recipient or affected resource.
- Group artifact generation should not appear here; external side effects still should.

### 6.12 Settings

Sections:

- Profile and account.
- Workspace defaults.
- Default model and reasoning effort.
- Channels and notification routing.
- Default approval policies.
- Data retention and history.
- Memory and privacy.
- Brand identity: company name, logo, colors, fonts, headers, footers, and artifact presets.
- Usage limits and budget alerts.
- Team members, roles, and permissions.
- API keys, webhooks, and developer settings.
- Billing and plan.

## 7. Shared components

- App shell, sidebar, header, breadcrumbs, page title, tabs, filters, command palette.
- Data table with sorting, pagination, column visibility, bulk actions, and responsive fallback.
- Cards, metric tiles, badges, avatars, agent identity chips, and channel icons.
- Status badge with semantic color and text label.
- Timeline, activity feed, run step, tool-call card, delegation card, approval card.
- File card, artifact preview, media viewer, code viewer, JSON viewer, and diff viewer.
- Modal, drawer, confirmation dialog, form fields, combobox, multi-select, date/time picker, schedule builder.
- Toast, inline alert, empty state, skeleton, error boundary, retry panel, and offline banner.
- Chart primitives for line, bar, stacked bar, donut, and timeline visualizations.

## 8. Interaction and state requirements

- All async actions show immediate feedback and cannot create duplicate requests on repeated clicks.
- Long-running actions stream progress and preserve the last known state after refresh.
- Refreshing the page must not lose a task, approval, preview URL, or artifact.
- Every failure has a human-readable summary, technical details drawer, retry action, and support/reference ID.
- Forms preserve valid input after validation failure.
- Empty states explain what the user can do next.
- Destructive operations require scope-specific confirmation.
- Keyboard focus remains visible and returns to the triggering control after dialogs close.

## 9. Responsive and accessibility requirements

- WCAG 2.2 AA target.
- Full keyboard navigation and screen-reader labels.
- Color cannot be the only status signal.
- Minimum 4.5:1 text contrast and 3:1 large-text contrast.
- Responsive breakpoints for mobile, tablet, and desktop.
- Tables become stacked cards or horizontally scrollable regions on small screens.
- Charts provide an accessible data table alternative.
- Reduced-motion mode disables nonessential animation.
- Timeouts, live updates, and status changes are announced appropriately.

## 10. Core data contracts

The frontend consumes typed API objects for:

- `Workspace`: id, name, provider, status, networkPolicy, resources, previewUrls, lifecycle.
- `Agent`: id, name, role, status, capabilities, tools, memoryScopes, activeRunCount.
- `Run`: id, objective, agent, channel, status, steps, cost, tokens, timestamps, outputs.
- `Approval`: id, tool, argumentsSummary, destination, risk, status, expiresAt.
- `Artifact`: id, name, type, size, sourceRunId, validation, visualQa, deliveryHistory, downloadUrl.
- `IntegrationAccount`: id, provider, label, owner, scopes, health, assignedAgents.
- `MemoryEntry`: id, category, value, source, confidence, visibility, expiry.
- `Automation`: id, objective, agent, schedule, destination, status, nextRun, lastRun.

All list endpoints need pagination, stable cursors, filtering, and consistent error envelopes.

## 11. Security and permissions

- Workspace, conversation, memory, integration, artifact, and billing access must be permission-checked server-side.
- Private memory and private assets must never appear in shared group views.
- Tool permissions are scoped by agent, workspace, account, and task.
- Approval records must be immutable after execution except for status transitions.
- Sensitive tokens and credentials are never rendered in logs or UI responses.
- Audit events record actor, agent, action, target, timestamp, channel, and result.

## 12. Performance requirements

- Overview first meaningful content under 2 seconds on a normal connection.
- Conversation history loads incrementally and supports virtualized long threads.
- Live run events update without full-page reload.
- Artifact previews lazy-load and use thumbnails before full files.
- Search results begin rendering within 500 ms after the server responds.
- The UI remains usable while a Daytona task or artifact render is running.

## 13. Acceptance criteria

- A user can identify active work, failures, approvals, and recent outputs from Overview.
- A user can trace a request from conversation to delegated specialist, tool calls, artifacts, and delivery.
- A user can create, pause, resume, and inspect a recurring specialist task.
- A user can connect multiple accounts for the same integration and assign them safely.
- A user can preview a Daytona app, inspect logs, and open its live URL.
- A user can preview and download a real PDF, DOCX, PPTX, XLSX, image, or project artifact.
- A user can distinguish structurally valid, visually checked, delivered, and failed artifacts.
- A group user cannot see private memory, private image assets, or private conversation history.
- A risky external action cannot execute without the configured approval boundary.
- Every important page has loading, empty, error, permission, and mobile states.

## 14. Delivery phases

### Phase 1 — operational core

App shell, Overview, Conversations, Tasks & Runs, Artifacts, approvals, responsive foundation, and live status updates.

### Phase 2 — control plane

Agents, Integrations, Memory, Automations, role-based access, audit logs, and settings.

### Phase 3 — builder platform

Daytona Workspaces, Browser, app previews, file editing, build/test evidence, GitHub delivery, and visual QA.

### Phase 4 — business intelligence

Analytics, cost controls, time-saved reporting, scheduled reports, team administration, and enterprise governance.

## 15. Definition of done

The dashboard is ready for production when the critical flows are implemented end-to-end, typed API contracts are covered by tests, permissions are enforced server-side, async states survive refresh, artifact delivery is verified, mobile and accessibility checks pass, and telemetry confirms that failures can be diagnosed without reading raw server logs.
