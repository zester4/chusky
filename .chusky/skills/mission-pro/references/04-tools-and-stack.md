# Tools and stack map

## How to think about tools

```text
Mission graph (supervisor)     → CHUCK_MISSION_*
Durable slices                 → CHUCK_TASK_*
Domain execution               → CHUCK_DELEGATE_SUBAGENT + CHUCK_* + Composio
Proactive monitoring           → attention-pulse skill + standing orders
Artifacts                      → CHUCK_CREATE_PDF / Daytona generators + CHUCK_ARTIFACT
Communications                 → channel tools + Composio email/Slack/etc.
```

## Specialists (delegate, don’t dump everything on one)

| Worker | Domain |
|--------|--------|
| Nora | Research, web, competitors |
| Lucas | Software, Daytona engineering |
| Maya | Social publish / integrations |
| Leo | Marketing / media |
| Sofia | Phone / voice |
| Dexter | GUI / computer use |
| Elena | Durable task operations |
| Ivy | Inbox / communications triage |
| Quinn | Sales / pipeline |
| Aria | Onboarding / success / churn |
| Kai | Metrics / analytics |

Supervisor starts/replans/verifies missions. Workers execute scoped steps.

## Composio

- Search with the project’s Composio tool search; use **exact verified slugs**
- Prefer domain routing skill (`composio-routing`) for major systems (Shopify, Stripe, Gmail, etc.)
- Web research: `COMPOSIO_SEARCH_WEB` (not a fake `web_search` name)
- Multi-execute: pause if nested action is risky or unclassifiable

## Native high-frequency tools in missions

- Files / computer: Daytona execute, PTY for long jobs, file details **before** artifact register
- PDF: structured sections; expand content before long page targets
- Reminders/jobs: link to `missionId` when a future check belongs to this outcome
- Memory: store durable facts; do not leak sensitive context into external messages

## Waiting tools

| Need | Tool |
|------|------|
| Exact webhook / provider callback | `CHUCK_MISSION_WAIT_EVENT` |
| Time-gated retry of same task | `CHUCK_TASK_WAIT` |
| Owner nudge later | `CHUCK_SET_REMINDER` (link mission) |
| Recurring same objective | `CHUCK_SCHEDULE_JOB` |

## Order of operations for deliverables

1. Generate file in workspace
2. Verify path + size (`CHUCK_DAYTONA_FILE_DETAILS` / list)
3. Register artifact
4. Attach evidence to mission
5. Verify definition of done

Never register a missing path.
